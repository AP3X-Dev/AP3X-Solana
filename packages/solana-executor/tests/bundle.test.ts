/**
 * Bundle path: each bundled intent is confirmed by its own transaction
 * signature, tips are real transfer instructions, a bundle with no tip is
 * rejected, and bundle submission fails over between Jito submitters.
 */

import { describe, expect, it, vi } from 'vitest';

import { base58, PublicKey } from '@ap3x/solana-core';
import type { AssemblerOptions, AssemblerResult } from '@ap3x/solana-tx';

import { Executor, transactionSignature } from '../src/executor.js';
import { HealthTracker, type Submitter } from '../src/submitter.js';

const PAYER = PublicKey.fromBytes(new Uint8Array(32).fill(1));
const TIP_ACCOUNT = PublicKey.fromBase58('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');
const SYSTEM_PROGRAM = PublicKey.fromBytes(new Uint8Array(32));

function fakeRpc() {
  const statusCalls: string[][] = [];
  return {
    statusCalls,
    pool: {
      pinForWrite: vi.fn(),
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getLatestBlockhash') return { value: { blockhash: 'GvkGSobrWGAohNcSd9zxj9GaJoQhXQJHQyK5Wn56QYHE' } };
        if (method === 'getSignatureStatuses') {
          const sigs = params[0] as string[];
          statusCalls.push(sigs);
          return { value: sigs.map(() => ({ slot: 300, confirmationStatus: 'confirmed', err: null })) };
        }
        return null;
      }),
    },
  };
}

/** Each assembled tx is `[1 || sig(64) || message]` with a distinct signature. */
function fakeAssemble() {
  const calls: AssemblerOptions[] = [];
  let n = 0;
  const assemble = async (opts: AssemblerOptions): Promise<AssemblerResult> => {
    calls.push(opts);
    n++;
    const tx = new Uint8Array(1 + 64 + 10);
    tx[0] = 1;
    tx.fill(n, 1, 65);
    return { signedTransaction: tx, messageBytes: tx.subarray(65), accountKeys: [PAYER] };
  };
  return { assemble, calls };
}

function jito(name: string, kind: 'jito-http' | 'jito-grpc', fail = false): Submitter & { submit: ReturnType<typeof vi.fn> } {
  return {
    name,
    kind,
    submit: vi.fn(async () => {
      if (fail) throw new Error(`${name} down`);
      return { kind: 'bundle' as const, bundleId: `${name}-bundle`, submitterUsed: name };
    }),
    health: () => ({ state: 'healthy' }),
  };
}

function executor(submitters: Submitter[], opts: { tipAccount?: PublicKey } = {}) {
  const rpc = fakeRpc();
  const asm = fakeAssemble();
  const exec = new Executor({
    rpcPool: rpc.pool as never,
    feeEstimator: { tier: () => 100 },
    resolveWallet: async () => ({ address: PAYER }) as never,
    submitters,
    defaultSubmitter: 'jito-grpc',
    ...(opts.tipAccount ? { jitoTipAccount: opts.tipAccount } : {}),
    bundleWindowMs: 5,
    pollIntervalMs: 1,
    assemble: asm.assemble,
    simulateAndBudget: async () => ({ unitsConsumed: 1, unitsLimit: 2 }),
  });
  return { exec, rpc, asm };
}

const intent = (id: string, tipLamports?: bigint) => ({
  intentId: id,
  wallet: 'main',
  instructions: [],
  feeTier: 'med' as const,
  deadline: Date.now() + 5_000,
  submitter: { kind: 'jito-grpc' as const, bundleGroup: 'g', ...(tipLamports !== undefined ? { tipLamports } : {}) },
});

describe('bundle execution', () => {
  it('confirms each bundled intent by its own transaction signature', async () => {
    const sub = jito('grpc', 'jito-grpc');
    const { exec, rpc } = executor([sub], { tipAccount: TIP_ACCOUNT });

    const [a, b] = await Promise.all([exec.submit(intent('a', 10_000n)), exec.submit(intent('b'))]);

    expect(sub.submit).toHaveBeenCalledOnce();
    const sent = sub.submit.mock.calls[0]![0] as { signedTxs: Uint8Array[] };
    expect(sent.signedTxs).toHaveLength(2);
    const expected = sent.signedTxs.map(transactionSignature);
    expect(a).toMatchObject({ kind: 'landed', signature: expected[0], submitterUsed: 'grpc' });
    expect(b).toMatchObject({ kind: 'landed', signature: expected[1], submitterUsed: 'grpc' });
    expect(rpc.statusCalls.flat()).toEqual(expect.arrayContaining(expected));
  });

  it('adds the tip as a system transfer to the tip account in the tipping intent only', async () => {
    const { exec, asm } = executor([jito('grpc', 'jito-grpc')], { tipAccount: TIP_ACCOUNT });
    await Promise.all([exec.submit(intent('a', 12_345n)), exec.submit(intent('b'))]);

    const [tipping, plain] = asm.calls;
    const tip = tipping!.instructions.at(-1)!;
    expect(tip.programId.equals(SYSTEM_PROGRAM)).toBe(true);
    expect(tip.keys.map((k) => k.pubkey.toBase58())).toEqual([PAYER.toBase58(), TIP_ACCOUNT.toBase58()]);
    expect(new DataView(tip.data.buffer, tip.data.byteOffset).getBigUint64(4, true)).toBe(12_345n);
    expect(plain!.instructions).toHaveLength(0);
  });

  it('rejects a bundle in which no intent tips', async () => {
    const sub = jito('grpc', 'jito-grpc');
    const { exec } = executor([sub], { tipAccount: TIP_ACCOUNT });
    const r = await exec.submit(intent('a'));
    expect(r).toMatchObject({ kind: 'rejected', error: { code: 'bundle_without_tip' } });
    expect(sub.submit).not.toHaveBeenCalled();
  });

  it('rejects a tip when no tip account is configured', async () => {
    const { exec } = executor([jito('grpc', 'jito-grpc')]);
    const r = await exec.submit(intent('a', 10_000n));
    expect(r).toMatchObject({ kind: 'rejected', error: { code: 'no_tip_account' } });
  });

  it('fails over to the other Jito submitter when one throws', async () => {
    const grpc = jito('grpc', 'jito-grpc', true);
    const http = jito('http', 'jito-http');
    const { exec } = executor([grpc, http], { tipAccount: TIP_ACCOUNT });
    const r = await exec.submit(intent('a', 10_000n));
    expect(r).toMatchObject({ kind: 'landed', submitterUsed: 'http' });
    expect(grpc.submit).toHaveBeenCalledOnce();
  });
});

describe('transactionSignature', () => {
  it('is the base58 of bytes 1..65', () => {
    const tx = new Uint8Array(100);
    tx[0] = 1;
    tx.fill(7, 1, 65);
    expect(transactionSignature(tx)).toBe(base58.encode(new Uint8Array(64).fill(7)));
  });

  it('rejects bytes that cannot hold a signature', () => {
    expect(() => transactionSignature(new Uint8Array(10))).toThrow(/too short/);
  });
});

describe('HealthTracker', () => {
  it('is unhealthy during the cooldown after a failure, degraded after, healthy after success', async () => {
    let now = 1_000;
    const h = new HealthTracker(100, () => now);
    expect(h.health().state).toBe('healthy');
    await expect(h.track(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(h.health()).toMatchObject({ state: 'unhealthy', reason: 'x' });
    now += 150;
    expect(h.health().state).toBe('degraded');
    await h.track(async () => 1);
    expect(h.health()).toEqual({ state: 'healthy', lastOkAt: now });
  });
});

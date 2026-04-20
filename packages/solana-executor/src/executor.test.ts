import { describe, expect, it, vi } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';
import type { AssemblerResult } from '@ap3x/solana-tx';

import { Executor } from './executor.js';
import type { Submitter } from './submitter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYS_PROGRAM = PublicKey.fromBytes(new Uint8Array(32));

function makeFakeRpc() {
  return {
    pinForWrite: vi.fn(),
    call: vi.fn(async (method: string) => {
      if (method === 'getLatestBlockhash') {
        // 32-byte all-ones hash — base58-encodes to a deterministic 43-44 char string.
        return { value: { blockhash: 'GvkGSobrWGAohNcSd9zxj9GaJoQhXQJHQyK5Wn56QYHE' } };
      }
      if (method === 'getSignatureStatuses') {
        return { value: [{ slot: 100, confirmationStatus: 'confirmed', err: null }] };
      }
      if (method === 'simulateTransaction') {
        return { value: { err: null, unitsConsumed: 150_000 } };
      }
      return null;
    }),
  };
}

function makeFakeWalletHandle() {
  return {
    address: SYS_PROGRAM,
    role: 'main',
    sign: vi.fn(async (msg: Uint8Array) => new Uint8Array(64).fill(msg[0] ?? 0)),
    signTransaction: vi.fn(async (tx: Uint8Array) => tx),
    isLocked: false,
    _lock: vi.fn(),
    toJSON: () => ({ address: SYS_PROGRAM.toBase58(), role: 'main', locked: false }),
  };
}

function makeFakeAssemble(): (opts: unknown) => Promise<AssemblerResult> {
  return async () => ({
    signedTransaction: new Uint8Array([1, 2, 3, 4, 5]),
    messageBytes: new Uint8Array([9, 9, 9]),
    accountKeys: [SYS_PROGRAM],
  });
}

function makeRpcSubmitter(): Submitter & { submit: ReturnType<typeof vi.fn> } {
  const submit = vi.fn(async () => ({
    kind: 'tx' as const,
    signature: 'sig-abc',
    submitterUsed: 'fake-rpc',
  }));
  return {
    name: 'fake-rpc',
    kind: 'rpc',
    submit,
    health: () => ({ state: 'healthy' }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Executor', () => {
  it('routes a single-tx intent through the rpc submitter and reports landed', async () => {
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();
    const submitter = makeRpcSubmitter();

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => handle as never,
      submitters: [submitter],
      defaultSubmitter: 'rpc',
      assemble: makeFakeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
    });

    const result = await exec.submit({
      intentId: 'i1',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() + 5000,
    });

    expect(result.kind).toBe('landed');
    if (result.kind === 'landed') {
      expect(result.signature).toBe('sig-abc');
      expect(result.submitterUsed).toBe('fake-rpc');
      expect(result.slot).toBe(100);
    }
    expect(submitter.submit).toHaveBeenCalledOnce();
  });

  it('rejects bundle intent synchronously when no Jito submitter is available', async () => {
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();
    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => handle as never,
      submitters: [makeRpcSubmitter()],
      defaultSubmitter: 'rpc',
      assemble: makeFakeAssemble(),
    });

    const result = await exec.submit({
      intentId: 'bundle-i1',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() + 5000,
      submitter: { kind: 'jito-http', bundleGroup: 'g1' },
    });

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.error.code).toBe('no_jito_submitter_for_bundle');
    }
    // No assembly should have happened.
    expect(rpcPool.call).not.toHaveBeenCalledWith('getLatestBlockhash', expect.anything());
  });

  it('surfaces wallet_locked when resolveWallet throws', async () => {
    const rpcPool = makeFakeRpc();
    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => {
        throw new Error('vault: wallet is locked');
      },
      submitters: [makeRpcSubmitter()],
      defaultSubmitter: 'rpc',
      assemble: makeFakeAssemble(),
    });

    const result = await exec.submit({
      intentId: 'i-lock',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() + 5000,
    });

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.error.code).toBe('wallet_locked');
      expect(result.error.message).toContain('locked');
    }
  });

  it('deduplicates duplicate intentIds via the in-flight map', async () => {
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();
    const submitter = makeRpcSubmitter();

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => handle as never,
      submitters: [submitter],
      defaultSubmitter: 'rpc',
      assemble: makeFakeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
    });

    const intent = {
      intentId: 'dup',
      wallet: 'main',
      instructions: [],
      feeTier: 'med' as const,
      deadline: Date.now() + 5000,
    };
    const [a, b] = await Promise.all([exec.submit(intent), exec.submit(intent)]);
    expect(a).toEqual(b);
    expect(submitter.submit).toHaveBeenCalledOnce();
  });

  it('falls back through fallbackChain when preferred submitter is unhealthy', async () => {
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();
    const unhealthyJito: Submitter = {
      name: 'jito-down',
      kind: 'jito-http',
      submit: vi.fn(async () => {
        throw new Error('should not be called');
      }),
      health: () => ({ state: 'unhealthy', reason: 'network' }),
    };
    const rpc = makeRpcSubmitter();

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => handle as never,
      submitters: [unhealthyJito, rpc],
      defaultSubmitter: 'rpc',
      fallbackChain: ['jito-http', 'rpc'],
      assemble: makeFakeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
    });

    const result = await exec.submit({
      intentId: 'fb-1',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() + 5000,
      submitter: { kind: 'jito-http' },
    });

    expect(result.kind).toBe('landed');
    expect(rpc.submit).toHaveBeenCalledOnce();
  });

  it('emits fee-tier event on submit', async () => {
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();
    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 42 },
      resolveWallet: async () => handle as never,
      submitters: [makeRpcSubmitter()],
      defaultSubmitter: 'rpc',
      assemble: makeFakeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
    });

    const events: unknown[] = [];
    exec.on('fee-tier', (e) => events.push(e));

    await exec.submit({
      intentId: 'fee-1',
      wallet: 'main',
      instructions: [],
      feeTier: 'high',
      deadline: Date.now() + 5000,
    });

    expect(events).toEqual([
      { intentId: 'fee-1', tier: 'high', microLamportsPerCu: 42 },
    ]);
  });
});

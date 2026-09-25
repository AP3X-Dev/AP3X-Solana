/**
 * Gate-5 failover: a submitter that throws is skipped within the same
 * attempt, and a submitter's own health tracking keeps it out of rotation on
 * later attempts until its cooldown ends.
 */

import { describe, expect, it, vi } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';
import type { AssemblerResult } from '@ap3x/solana-tx';

import { Executor } from '../src/executor.js';
import { HealthTracker, type Submitter } from '../src/submitter.js';

const SYS_PROGRAM = PublicKey.fromBytes(new Uint8Array(32));

function makeFakeRpc() {
  return {
    pinForWrite: vi.fn(),
    call: vi.fn(async (method: string) => {
      if (method === 'getLatestBlockhash') {
        return { value: { blockhash: 'GvkGSobrWGAohNcSd9zxj9GaJoQhXQJHQyK5Wn56QYHE' } };
      }
      if (method === 'getSignatureStatuses') {
        return { value: [{ slot: 200, confirmationStatus: 'confirmed', err: null }] };
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
    sign: vi.fn(async () => new Uint8Array(64)),
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

describe('Executor failover', () => {
  it('fails over to the next submitter within the same attempt', async () => {
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();

    // Primary still reports healthy — the executor must not rely on the
    // submitter noticing its own failure before trying the next one.
    const primarySubmit = vi.fn(async () => {
      throw new Error('primary RPC down');
    });
    const primary: Submitter = { name: 'primary', kind: 'rpc', submit: primarySubmit, health: () => ({ state: 'healthy' }) };
    const backupSubmit = vi.fn(async () => ({ kind: 'tx' as const, signature: 'sig-backup', submitterUsed: 'backup' }));
    const backup: Submitter = { name: 'backup', kind: 'rpc', submit: backupSubmit, health: () => ({ state: 'healthy' }) };

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => handle as never,
      submitters: [primary, backup],
      defaultSubmitter: 'rpc',
      assemble: makeFakeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
    });
    const attempts: unknown[] = [];
    exec.on('executor.attempt', (e) => attempts.push(e));

    const result = await exec.submit({
      intentId: 'failover-1',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() + 5000,
    });

    expect(result).toMatchObject({ kind: 'landed', signature: 'sig-backup', submitterUsed: 'backup' });
    expect(primarySubmit).toHaveBeenCalledOnce();
    expect(backupSubmit).toHaveBeenCalledOnce();
    // Default retry (1 attempt) was enough.
    expect(attempts).toHaveLength(1);
  });

  it('a failed submitter sits out the retry until its cooldown ends', async () => {
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();

    const primaryHealth = new HealthTracker(60_000);
    const primarySubmit = vi.fn(async () => primaryHealth.track(async () => {
      throw new Error('boom');
    }));
    const primary: Submitter = { name: 'primary', kind: 'rpc', submit: primarySubmit, health: () => primaryHealth.health() };
    let backupCalls = 0;
    const backup: Submitter = {
      name: 'backup',
      kind: 'rpc',
      submit: vi.fn(async () => {
        if (backupCalls++ === 0) throw new Error('transient');
        return { kind: 'tx' as const, signature: 'sig-backup', submitterUsed: 'backup' };
      }),
      health: () => ({ state: 'healthy' }),
    };

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => handle as never,
      submitters: [primary, backup],
      defaultSubmitter: 'rpc',
      assemble: makeFakeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
    });
    const results: Array<{ kind: string }> = [];
    exec.on('result', (r) => results.push(r));

    const final = await exec.submit({
      intentId: 'failover-2',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() + 5000,
      retry: { maxAttempts: 2, bumpProgression: false },
    });

    expect(final).toMatchObject({ kind: 'landed', submitterUsed: 'backup' });
    expect(results.map((r) => r.kind)).toEqual(['rejected', 'landed']);
    expect(primarySubmit).toHaveBeenCalledOnce();
    expect(primaryHealth.health().state).toBe('unhealthy');
  });
});

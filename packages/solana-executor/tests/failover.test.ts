/**
 * Gate-5 failover test — when the primary submitter throws on the first
 * attempt, the retry loop re-enters `#execute` and the second attempt lands
 * through the backup submitter.
 *
 * The scenario:
 *   - Two RPC submitters: `primary` (throws once, then unhealthy) and `backup`
 *     (healthy, returns a signature).
 *   - Intent carries `retry: { maxAttempts: 2, bumpProgression: false }`, so
 *     the tier stays the same across retries — we're exercising failover,
 *     not fee escalation.
 *   - Attempt 1: `#execute` picks `primary` (first in submitters array),
 *     `primary.submit` throws → `rejected { code: 'submit_failed' }`. The
 *     retry loop flips `primary.health` to unhealthy between attempts.
 *   - Attempt 2: `#pickSubmitter` skips the unhealthy primary and picks
 *     `backup`, which returns `sig-backup`. `confirmLanded` reports it.
 *   - Final result: `landed` with `submitterUsed = 'backup'`.
 *
 * Two `executor.attempt` events fire, both at the caller's tier.
 */

import { describe, expect, it, vi } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';
import type { AssemblerResult } from '@ap3x/solana-tx';

import { Executor } from '../src/executor.js';
import type { Submitter, SubmitterHealth } from '../src/submitter.js';

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

describe('Executor failover (retry across submitters)', () => {
  it('primary submitter throws → backup lands on retry', async () => {
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();

    // Primary: throws once, and is toggled unhealthy on first failure so the
    // retry picks the backup. This mirrors a real RPC endpoint's health
    // probe surfacing a fault between attempts.
    let primaryHealth: SubmitterHealth = { state: 'healthy' };
    const primarySubmit = vi.fn(async () => {
      primaryHealth = { state: 'unhealthy', reason: 'connection refused' };
      throw new Error('primary RPC down');
    });
    const primary: Submitter = {
      name: 'primary',
      kind: 'rpc',
      submit: primarySubmit,
      health: () => primaryHealth,
    };

    const backupSubmit = vi.fn(async () => ({
      kind: 'tx' as const,
      signature: 'sig-backup',
      submitterUsed: 'backup',
    }));
    const backup: Submitter = {
      name: 'backup',
      kind: 'rpc',
      submit: backupSubmit,
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

    const attempts: Array<{ intentId: string; attempt: number; feeTier: string }> = [];
    exec.on('executor.attempt', (e) => attempts.push(e));

    const result = await exec.submit({
      intentId: 'failover-1',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() + 5000,
      retry: { maxAttempts: 2, bumpProgression: false },
    });

    // Final result: landed, via the backup submitter.
    expect(result.kind).toBe('landed');
    if (result.kind === 'landed') {
      expect(result.signature).toBe('sig-backup');
      expect(result.submitterUsed).toBe('backup');
    }

    // Primary took the first attempt and threw; backup took the second.
    expect(primarySubmit).toHaveBeenCalledOnce();
    expect(backupSubmit).toHaveBeenCalledOnce();

    // Two attempt events, both at the caller's `med` tier (no bump).
    expect(attempts).toEqual([
      { intentId: 'failover-1', attempt: 1, feeTier: 'med' },
      { intentId: 'failover-1', attempt: 2, feeTier: 'med' },
    ]);
  });

  it('attempt 1 rejection is observable via result events before the retry completes', async () => {
    // Extra coverage: confirm each attempt still fires a `result` event, so
    // downstream telemetry sees both the transient rejection AND the final
    // landed outcome — not just the landed envelope.
    const rpcPool = makeFakeRpc();
    const handle = makeFakeWalletHandle();

    let primaryHealth: SubmitterHealth = { state: 'healthy' };
    const primary: Submitter = {
      name: 'primary',
      kind: 'rpc',
      submit: vi.fn(async () => {
        primaryHealth = { state: 'unhealthy' };
        throw new Error('boom');
      }),
      health: () => primaryHealth,
    };
    const backup: Submitter = {
      name: 'backup',
      kind: 'rpc',
      submit: vi.fn(async () => ({
        kind: 'tx' as const,
        signature: 'sig-backup',
        submitterUsed: 'backup',
      })),
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

    expect(final.kind).toBe('landed');
    // Two result envelopes: the transient rejected on attempt 1, the landed on
    // attempt 2. Consumers that want the terminal outcome use the return
    // value; subscribers that want per-attempt telemetry use the event.
    expect(results.map((r) => r.kind)).toEqual(['rejected', 'landed']);
  });
});

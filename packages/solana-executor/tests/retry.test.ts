/**
 * Retry test — fee-tier bump progression.
 *
 * The scenario:
 *   - Submitter `.submit()` returns a signature cleanly every time.
 *   - But `confirmLanded` times out on every attempt (deadline already
 *     reached) → retry loop treats each `timeout` result as retryable and
 *     bumps the tier per `BUMP_PROGRESSION`.
 *   - Intent starts at `feeTier: 'low'` with `retry: { maxAttempts: 3,
 *     bumpProgression: true }`.
 *
 * Assertions:
 *   - `executor.attempt` events carry tiers `['low', 'med', 'high']`
 *     (starting tier + 2 bumps, one per retry).
 *   - `feeEstimator.tier` is called once per attempt with the current tier —
 *     proves the retry loop passes the bumped tier into `#execute` rather
 *     than reusing the caller's original intent.
 *   - Final result is `timeout` (retries exhausted).
 *
 * Also exercises: tier plateau at `turbo` when starting near the top of the
 * progression, and `maxAttempts: 1` defaulting (no retry at all).
 */

import { describe, expect, it, vi } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';
import type { AssemblerResult } from '@ap3x/solana-tx';

import { Executor, BUMP_PROGRESSION } from '../src/executor.js';
import type { Submitter } from '../src/submitter.js';
import type { FeeTier } from '../src/types.js';

const SYS_PROGRAM = PublicKey.fromBytes(new Uint8Array(32));

function makeRpcPoolTimingOut() {
  // getSignatureStatuses returns null (status unknown) — with the deadline
  // already reached, `confirmLanded` exits its `while` loop immediately and
  // returns `{ kind: 'timeout' }`. The while-guard checks `Date.now() <
  // deadline` before each poll iteration, so a past deadline short-circuits
  // without ever sleeping.
  return {
    pinForWrite: vi.fn(),
    call: vi.fn(async (method: string) => {
      if (method === 'getLatestBlockhash') {
        return { value: { blockhash: 'GvkGSobrWGAohNcSd9zxj9GaJoQhXQJHQyK5Wn56QYHE' } };
      }
      if (method === 'getSignatureStatuses') {
        return { value: [null] };
      }
      if (method === 'simulateTransaction') {
        return { value: { err: null, unitsConsumed: 150_000 } };
      }
      return null;
    }),
  };
}

function makeHandle() {
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

function makeAssemble(): (opts: unknown) => Promise<AssemblerResult> {
  return async () => ({
    signedTransaction: new Uint8Array([1, 2, 3, 4, 5]),
    messageBytes: new Uint8Array([9, 9, 9]),
    accountKeys: [SYS_PROGRAM],
  });
}

function makeLandingSubmitter(): Submitter {
  return {
    name: 'rpc',
    kind: 'rpc',
    submit: vi.fn(async () => ({
      kind: 'tx' as const,
      signature: 'sig-accepted',
      submitterUsed: 'rpc',
    })),
    health: () => ({ state: 'healthy' }),
  };
}

describe('Executor retry (fee-tier bump progression)', () => {
  it('bumps tier per attempt when bumpProgression is true', async () => {
    const rpcPool = makeRpcPoolTimingOut();
    const handle = makeHandle();
    const submitter = makeLandingSubmitter();

    // Instrument the fee estimator so we can observe which tier each attempt
    // requested. Returning a nominal µLamports-per-CU value (the executor
    // emits it but we don't read it back).
    const tierCalls: FeeTier[] = [];
    const feeEstimator = {
      tier: vi.fn((t: FeeTier) => {
        tierCalls.push(t);
        return 100;
      }),
    };

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator,
      resolveWallet: async () => handle as never,
      submitters: [submitter],
      defaultSubmitter: 'rpc',
      assemble: makeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
      // Zero poll interval so the timeout path returns without sleeping.
      pollIntervalMs: 1,
    });

    const attempts: Array<{ intentId: string; attempt: number; feeTier: FeeTier }> = [];
    exec.on('executor.attempt', (e) => attempts.push(e));

    // Deadline already in the past → confirmLanded returns timeout
    // immediately on every attempt, driving the retry loop.
    const result = await exec.submit({
      intentId: 'retry-bump',
      wallet: 'main',
      instructions: [],
      feeTier: 'low',
      deadline: Date.now() - 1,
      retry: { maxAttempts: 3, bumpProgression: true },
    });

    expect(result.kind).toBe('timeout');

    // Three attempts, tiers progressing through the ladder.
    expect(attempts).toEqual([
      { intentId: 'retry-bump', attempt: 1, feeTier: 'low' },
      { intentId: 'retry-bump', attempt: 2, feeTier: 'med' },
      { intentId: 'retry-bump', attempt: 3, feeTier: 'high' },
    ]);

    // Fee estimator saw the same tier progression — confirms the bumped tier
    // is actually what `#execute` uses, not just what the event reports.
    expect(tierCalls).toEqual(['low', 'med', 'high']);

    // Submitter was called once per attempt — `confirmLanded` decided each
    // was a timeout, not the submit call.
    expect(submitter.submit).toHaveBeenCalledTimes(3);
  });

  it('does not bump when bumpProgression is false — retries reuse the caller tier', async () => {
    const rpcPool = makeRpcPoolTimingOut();
    const handle = makeHandle();
    const submitter = makeLandingSubmitter();
    const tierCalls: FeeTier[] = [];

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: {
        tier: (t: FeeTier) => {
          tierCalls.push(t);
          return 100;
        },
      },
      resolveWallet: async () => handle as never,
      submitters: [submitter],
      defaultSubmitter: 'rpc',
      assemble: makeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
      pollIntervalMs: 1,
    });

    const attempts: FeeTier[] = [];
    exec.on('executor.attempt', (e) => attempts.push(e.feeTier));

    await exec.submit({
      intentId: 'retry-flat',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() - 1,
      retry: { maxAttempts: 3, bumpProgression: false },
    });

    // All three attempts at the caller's tier.
    expect(attempts).toEqual(['med', 'med', 'med']);
    expect(tierCalls).toEqual(['med', 'med', 'med']);
  });

  it('plateaus at turbo — bump progression never climbs past the top', async () => {
    const rpcPool = makeRpcPoolTimingOut();
    const handle = makeHandle();
    const submitter = makeLandingSubmitter();

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => handle as never,
      submitters: [submitter],
      defaultSubmitter: 'rpc',
      assemble: makeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
      pollIntervalMs: 1,
    });

    const attempts: FeeTier[] = [];
    exec.on('executor.attempt', (e) => attempts.push(e.feeTier));

    await exec.submit({
      intentId: 'retry-plateau',
      wallet: 'main',
      instructions: [],
      feeTier: 'high',
      deadline: Date.now() - 1,
      retry: { maxAttempts: 4, bumpProgression: true },
    });

    // high → turbo → turbo → turbo. Once at the top, we stop climbing.
    expect(attempts).toEqual(['high', 'turbo', 'turbo', 'turbo']);
  });

  it('defaults to a single attempt when retry is unset', async () => {
    const rpcPool = makeRpcPoolTimingOut();
    const handle = makeHandle();
    const submitter = makeLandingSubmitter();

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => handle as never,
      submitters: [submitter],
      defaultSubmitter: 'rpc',
      assemble: makeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
      pollIntervalMs: 1,
    });

    const attempts: FeeTier[] = [];
    exec.on('executor.attempt', (e) => attempts.push(e.feeTier));

    const result = await exec.submit({
      intentId: 'retry-default',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() - 1,
    });

    expect(result.kind).toBe('timeout');
    expect(attempts).toEqual(['med']);
  });

  it('does not retry on terminal rejections (wallet_locked)', async () => {
    const rpcPool = makeRpcPoolTimingOut();
    const submitter = makeLandingSubmitter();

    const exec = new Executor({
      rpcPool: rpcPool as never,
      feeEstimator: { tier: () => 100 },
      resolveWallet: async () => {
        throw new Error('vault: wallet is locked');
      },
      submitters: [submitter],
      defaultSubmitter: 'rpc',
      assemble: makeAssemble(),
      simulateAndBudget: async () => ({ unitsConsumed: 150_000, unitsLimit: 172_500 }),
      pollIntervalMs: 1,
    });

    const attempts: FeeTier[] = [];
    exec.on('executor.attempt', (e) => attempts.push(e.feeTier));

    const result = await exec.submit({
      intentId: 'retry-locked',
      wallet: 'main',
      instructions: [],
      feeTier: 'low',
      deadline: Date.now() + 5000,
      retry: { maxAttempts: 3, bumpProgression: true },
    });

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.error.code).toBe('wallet_locked');
    }
    // Exactly one attempt — terminal reject short-circuits the retry loop.
    expect(attempts).toEqual(['low']);
  });

  it('BUMP_PROGRESSION is the canonical [low, med, high, turbo] ladder', () => {
    expect(BUMP_PROGRESSION).toEqual(['low', 'med', 'high', 'turbo']);
  });
});

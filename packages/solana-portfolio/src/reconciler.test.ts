import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { Reconciler } from './reconciler.js';
import type { DriftEvent } from './types.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');

const fakeStore = (positions: any[]) => ({
  getAllPositions: vi.fn(async () => positions),
  getPosition: vi.fn(async () => positions[0]),
  on: vi.fn(),
  emit: vi.fn(),
});
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const acct = (mint: PublicKey, amount: string) => ({
  account: { data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount } } } } },
});
// Token accounts per token program; getTokenAccountsByOwner filters by program.
const fakeRpcPool = (byProgram: Record<string, unknown[]>): never =>
  ({
    call: vi.fn(async (_m: string, params: [string, { programId: string }]) => ({
      value: byProgram[params[1].programId] ?? [],
    })),
  }) as never;

describe('Reconciler', () => {
  it('reports failed background passes and retries on the next tick without inventing drift', async () => {
    vi.useFakeTimers();
    const error = new Error('balance provider unavailable');
    const onError = vi.fn();
    const onDrift = vi.fn();
    const store = fakeStore([]);
    const call = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ value: [] });
    const reconciler = new Reconciler({ portfolioStore: store, rpcPool: { call } as never,
      walletAddresses: [wallet], intervalMs: 100, onError, onDrift });
    try {
      reconciler.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(onDrift).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(store.getAllPositions).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledOnce();
      call.mockRejectedValueOnce(error);
      await expect(reconciler.runOnce()).rejects.toBe(error);
    } finally { reconciler.stop(); vi.useRealTimers(); }
  });

  it('reports a failed background pass to stderr when no error callback is supplied', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('balance provider unavailable');
    const reconciler = new Reconciler({ portfolioStore: fakeStore([]), rpcPool: { call: vi.fn().mockRejectedValue(error) } as never,
      walletAddresses: [wallet], intervalMs: 100 });
    try {
      reconciler.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(stderr).toHaveBeenCalledWith('Portfolio reconciliation failed:', error);
    } finally { reconciler.stop(); stderr.mockRestore(); vi.useRealTimers(); }
  });

  it('starts one timer and releases it on stop, including repeated lifecycle calls', async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore([]);
      const reconciler = new Reconciler({ portfolioStore: store, rpcPool: fakeRpcPool({}), walletAddresses: [wallet], intervalMs: 100 });
      reconciler.stop();
      reconciler.start();
      reconciler.start();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(store.getAllPositions).toHaveBeenCalledOnce();
      reconciler.stop();
      reconciler.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(store.getAllPositions).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('reports missing on-chain balances and unknown last signatures without rebuilding when disabled', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 5n, acquiredSig: '' }], lastUpdatedSlot: 0 }]);
    const onDrift = vi.fn();
    await new Reconciler({ portfolioStore: store as never, rpcPool: fakeRpcPool({}), walletAddresses: [wallet], onDrift, rebuildOnDrift: false }).runOnce();
    expect(onDrift).toHaveBeenCalledWith(expect.objectContaining({ expected: 5n, observed: 0n, diff: -5n, lastKnownLandedSig: null }));
    const empty = fakeStore([{ mint, walletAddress: wallet, lots: [], lastUpdatedSlot: 0 }]);
    const rpcPool = fakeRpcPool({ [TOKEN]: [acct(mint, '1')] });
    onDrift.mockClear();
    await new Reconciler({ portfolioStore: empty as never, rpcPool, walletAddresses: [wallet], onDrift }).runOnce();
    expect(onDrift).toHaveBeenCalledWith(expect.objectContaining({ expected: 0n, observed: 1n, lastKnownLandedSig: null }));
    await expect(new Reconciler({ portfolioStore: empty as never, rpcPool, walletAddresses: [wallet] }).runOnce()).resolves.toBeUndefined();
  });

  it('emits drift when on-chain balance differs from stored', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 100n }], lastUpdatedSlot: 0 }]);
    const rpcPool = fakeRpcPool({ [TOKEN]: [acct(mint, '120')] });
    const drifts: any[] = [];
    const reconciler = new Reconciler({ portfolioStore: store as any, rpcPool, walletAddresses: [wallet], intervalMs: 100, onDrift: (e) => drifts.push(e) });
    await reconciler.runOnce();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.diff).toBe(20n);
  });

  it('does not emit drift when balances match', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 100n }], lastUpdatedSlot: 0 }]);
    const rpcPool = fakeRpcPool({ [TOKEN]: [acct(mint, '100')] });
    const drifts: any[] = [];
    const reconciler = new Reconciler({ portfolioStore: store as any, rpcPool, walletAddresses: [wallet], intervalMs: 100, onDrift: (e) => drifts.push(e) });
    await reconciler.runOnce();
    expect(drifts).toHaveLength(0);
  });

  it('counts Token-2022 accounts and sums multiple accounts per mint', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 100n }], lastUpdatedSlot: 0 }]);
    const rpcPool = fakeRpcPool({ [TOKEN]: [acct(mint, '40')], [TOKEN_2022]: [acct(mint, '60')] });
    const drifts: DriftEvent[] = [];
    await new Reconciler({ portfolioStore: store as never, rpcPool, walletAddresses: [wallet], onDrift: (e) => drifts.push(e) }).runOnce();
    expect(drifts).toHaveLength(0);
  });

  it('rebuilds a drifted position when the store supports it', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = { ...fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 100n }], lastUpdatedSlot: 0 }]), rebuildPosition: vi.fn(async () => undefined) };
    const rpcPool = fakeRpcPool({ [TOKEN]: [acct(mint, '70')] });
    await new Reconciler({ portfolioStore: store as never, rpcPool, walletAddresses: [wallet] }).runOnce();
    expect(store.rebuildPosition).toHaveBeenCalledWith(wallet, mint, 70n);

    const noRebuild = { ...store, rebuildPosition: vi.fn(async () => undefined) };
    await new Reconciler({ portfolioStore: noRebuild as never, rpcPool, walletAddresses: [wallet], rebuildOnDrift: false }).runOnce();
    expect(noRebuild.rebuildPosition).not.toHaveBeenCalled();
  });
});

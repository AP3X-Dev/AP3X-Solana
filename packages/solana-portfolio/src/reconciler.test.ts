import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { Reconciler } from './reconciler.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');

const fakeStore = (positions: any[]) => ({
  getAllPositions: vi.fn(async () => positions),
  getPosition: vi.fn(async () => positions[0]),
  on: vi.fn(),
  emit: vi.fn(),
});
const fakeRpcPool = (tokenAccounts: any[]): any => ({
  call: vi.fn(async () => ({ value: tokenAccounts })),
});

describe('Reconciler', () => {
  it('emits drift when on-chain balance differs from stored', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 100n }], lastUpdatedSlot: 0 }]);
    const rpcPool = fakeRpcPool([
      { account: { data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount: '120' } } } } } },
    ]);
    const drifts: any[] = [];
    const reconciler = new Reconciler({ portfolioStore: store as any, rpcPool, walletAddresses: [wallet], intervalMs: 100, onDrift: (e) => drifts.push(e) });
    await reconciler.runOnce();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.diff).toBe(20n);
  });

  it('does not emit drift when balances match', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 100n }], lastUpdatedSlot: 0 }]);
    const rpcPool = fakeRpcPool([
      { account: { data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount: '100' } } } } } },
    ]);
    const drifts: any[] = [];
    const reconciler = new Reconciler({ portfolioStore: store as any, rpcPool, walletAddresses: [wallet], intervalMs: 100, onDrift: (e) => drifts.push(e) });
    await reconciler.runOnce();
    expect(drifts).toHaveLength(0);
  });
});

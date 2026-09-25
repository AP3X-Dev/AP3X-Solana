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

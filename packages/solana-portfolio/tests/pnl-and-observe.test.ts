import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicKey } from '@ap3x/solana-core';
import {
  CostBasisReconstructor,
  FilePortfolioStore,
  PRICE_SCALE,
  SwapTracerRegistry,
  unrealizedPnl,
} from '@ap3x/solana-portfolio';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-pnl-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mintA = PublicKey.fromBase58('11111111111111111111111111111113');
const mintB = PublicKey.fromBase58('11111111111111111111111111111114');

const trade = (mint: PublicKey, amountDelta: bigint, solFlowLamports: bigint, slot: number) => ({
  signature: `s${slot}`, slot, wallet, mint, amountDelta, solFlowLamports, feeLamports: 0n, source: 'executor' as const,
});

describe('realized PnL', () => {
  it('is tracked per mint, including losses, and survives a reload', async () => {
    const store = new FilePortfolioStore({ dir });
    await store.applyLandedTrade(trade(mintA, 100n, -1_000n, 1));
    await store.applyLandedTrade(trade(mintA, -100n, 1_500n, 2)); // +500
    await store.applyLandedTrade(trade(mintB, 10n, -1_000n, 3));
    await store.applyLandedTrade(trade(mintB, -10n, 400n, 4)); // -600

    const reloaded = new FilePortfolioStore({ dir });
    expect(await reloaded.getRealizedPnl(wallet, mintA)).toBe(500n);
    expect(await reloaded.getRealizedPnl(wallet, mintB)).toBe(-600n);
  });
});

describe('unrealized PnL', () => {
  it('marks open lots to the given price', async () => {
    const store = new FilePortfolioStore({ dir });
    await store.applyLandedTrade(trade(mintA, 1_000n, -2_000n, 1));
    // 3 lamports per base unit → value 3_000, basis 2_000.
    expect(await store.getUnrealizedPnl(wallet, mintA, 3n * PRICE_SCALE)).toBe(1_000n);
    expect(await store.getUnrealizedPnl(wallet, mintB, 3n * PRICE_SCALE)).toBe(0n);
  });

  it('shared helper matches', () => {
    const lots = [{ amount: 500n, costBasisLamports: 100n, acquiredSlot: 1, acquiredSig: 'a', source: 'trade' as const }];
    expect(unrealizedPnl(lots, PRICE_SCALE / 2n)).toBe(150n);
  });
});

describe('observe', () => {
  const tokenAccounts = (amount: string) => ({
    value: [{ account: { data: { parsed: { info: { mint: mintA.toBase58(), tokenAmount: { amount } } } } } }],
  });

  function rpcWith(balance: string) {
    return {
      call: vi.fn(async (method: string, params: any[]) => {
        if (method === 'getTokenAccountsByOwner') {
          return params[1].programId.startsWith('Tokenkeg') ? tokenAccounts(balance) : { value: [] };
        }
        if (method === 'getSignaturesForAddress') return [];
        return null;
      }),
    } as any;
  }

  it('cold-starts untracked holdings once and sets the wallet accounting method', async () => {
    const rpcPool = rpcWith('250');
    const reconstructor = new CostBasisReconstructor({ rpcPool, tracerRegistry: new SwapTracerRegistry() });
    const store = new FilePortfolioStore({ dir, rpcPool, reconstructor });

    const changes = await store.observe(wallet, { method: 'lifo' });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.reason).toBe('cold-start');
    const pos = await store.getPosition(wallet, mintA);
    expect(pos!.lots.reduce((s, l) => s + l.amount, 0n)).toBe(250n);

    // Second observe: position exists, no re-walk.
    expect(await store.observe(wallet)).toHaveLength(0);

    // LIFO applies to later sells: two buys at different prices, sell one lot.
    await store.applyLandedTrade(trade(mintA, 10n, -100n, 10));
    await store.applyLandedTrade(trade(mintA, 10n, -300n, 11));
    await store.applyLandedTrade(trade(mintA, -10n, 300n, 12));
    expect(await store.getRealizedPnl(wallet, mintA)).toBe(0n); // newest lot (basis 300) sold for 300
  });

  it('requires chain access', async () => {
    await expect(new FilePortfolioStore({ dir }).observe(wallet)).rejects.toThrow(/rpcPool and reconstructor/);
  });

  it('rebuildPosition replaces lots and records the reason', async () => {
    const rpcPool = rpcWith('0');
    const reconstructor = new CostBasisReconstructor({ rpcPool, tracerRegistry: new SwapTracerRegistry() });
    const store = new FilePortfolioStore({ dir, rpcPool, reconstructor });
    await store.applyLandedTrade(trade(mintA, 100n, -1_000n, 1));
    const change = await store.rebuildPosition(wallet, mintA, 40n);
    expect(change.reason).toBe('reconcile');
    expect(change.before!.lots[0]!.amount).toBe(100n);
    expect((await store.getPosition(wallet, mintA))!.lots.reduce((s, l) => s + l.amount, 0n)).toBe(40n);
  });
});

describe('correctLotBasis', () => {
  it('updates the lot, clears the unresolved flag and audits', async () => {
    const store = new FilePortfolioStore({ dir });
    await store.applyLandedTrade(trade(mintA, 100n, 0n, 1));
    const { oldBasis } = await store.correctLotBasis(wallet, mintA, 0, 777n);
    expect(oldBasis).toBe(0n);
    const lot = (await store.getPosition(wallet, mintA))!.lots[0]!;
    expect(lot.costBasisLamports).toBe(777n);
    expect(lot.basisUnresolved).toBe(false);
    expect((await store.readAudit(wallet)).at(-1)!.event).toBe('manual-correction');
    await expect(store.correctLotBasis(wallet, mintA, 5, 1n)).rejects.toThrow(/out of range/);
  });
});

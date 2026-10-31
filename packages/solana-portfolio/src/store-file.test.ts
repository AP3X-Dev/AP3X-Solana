import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublicKey } from '@ap3x/solana-core';
import { FilePortfolioStore } from './store-file.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

describe('FilePortfolioStore', () => {
  it('keeps exact sale proceeds and realized PnL after reopening the store', async () => {
    const store = new FilePortfolioStore({ dir });
    const trade = { signature: 'buy', slot: 1, wallet, mint, amountDelta: 100n,
      solFlowLamports: -1000n, feeLamports: 0n, source: 'external' as const };
    await store.applyLandedTrade(trade);
    await store.applyLandedTrade({ ...trade, signature: 'sell', slot: 2, amountDelta: -50n, solFlowLamports: 1500n });
    const reopened = new FilePortfolioStore({ dir });
    expect(await reopened.getRealizedPnl(wallet, mint)).toBe(1000n);
    expect((await reopened.getPosition(wallet, mint))!.lots).toMatchObject([{ amount: 50n, costBasisLamports: 500n }]);
    expect(await reopened.getUnrealizedPnl(wallet, mint, 20_000_000_000n)).toBe(500n);
  });

  it('rejects invalid corrections without changing the file and recovers for a subsequent correction', async () => {
    const store = new FilePortfolioStore({ dir });
    await expect(store.correctLotBasis(wallet, mint, 0, 1n)).rejects.toThrow('no position');
    await store._upsertForTest({ mint, walletAddress: wallet, lastUpdatedSlot: 1,
      lots: [{ amount: 2n, costBasisLamports: 0n, acquiredSlot: 1, acquiredSig: '', source: 'cold-start-unresolved', basisUnresolved: true }] });
    for (const index of [-1, 0.5, NaN, Infinity, 9007199254740992]) {
      await expect(store.correctLotBasis(wallet, mint, index, 9n)).rejects.toThrow('lot index');
    }
    await expect(store.correctLotBasis(wallet, mint, 0, -1n)).rejects.toThrow('cost basis');
    await expect(store.correctLotBasis(wallet, mint, 0, 1 as never)).rejects.toThrow('cost basis');
    expect(await store.readAudit(wallet)).toEqual([]);
    await expect(store.correctLotBasis(wallet, mint, 3, 9n)).rejects.toThrow('lot index out of range');
    expect((await store.getPosition(wallet, mint))!.lots[0]!.basisUnresolved).toBe(true);
    expect(await store.correctLotBasis(wallet, mint, 0, 9007199254740993n)).toEqual({ oldBasis: 0n });
    expect((await new FilePortfolioStore({ dir }).getPosition(wallet, mint))!.lots[0]).toMatchObject({ costBasisLamports: 9007199254740993n, basisUnresolved: false });
    expect(await store.readAudit(wallet)).toMatchObject([{ event: 'manual-correction', meta: { oldBasis: '0', newBasis: '9007199254740993' } }]);
  });

  it('returns empty read results for an untracked wallet and requires chain access for reconstruction', async () => {
    const store = new FilePortfolioStore({ dir });
    expect(await store.getAllPositions(wallet)).toEqual([]);
    expect(await store.readAudit(wallet)).toEqual([]);
    expect(await store.getRealizedPnl(wallet, mint)).toBe(0n);
    expect(await store.getUnrealizedPnl(wallet, mint, 1n)).toBe(0n);
    await expect(store.observe(wallet)).rejects.toThrow('needs the rpcPool and reconstructor');
    await expect(store.rebuildPosition(wallet, mint, 1n)).rejects.toThrow('needs the rpcPool and reconstructor');
  });

  it('surfaces corrupted wallet and audit data instead of treating them as missing', async () => {
    const store = new FilePortfolioStore({ dir });
    await fs.writeFile(path.join(dir, `${wallet.toBase58()}.json`), '{corrupt');
    await fs.writeFile(path.join(dir, `${wallet.toBase58()}.audit.jsonl`), '{corrupt');
    await expect(store.getAllPositions(wallet)).rejects.toThrow(SyntaxError);
    await expect(store.readAudit(wallet)).rejects.toThrow(SyntaxError);
  });

  it('returns null for unknown position', async () => {
    const store = new FilePortfolioStore({ dir });
    expect(await store.getPosition(wallet, mint)).toBeNull();
  });

  it('round-trips a position via internal upsert', async () => {
    const store = new FilePortfolioStore({ dir });
    await store._upsertForTest({
      mint, walletAddress: wallet, lastUpdatedSlot: 100,
      lots: [{ amount: 1000n, costBasisLamports: 500n, acquiredSlot: 100, acquiredSig: 's1', source: 'trade' }],
    });
    const got = await store.getPosition(wallet, mint);
    expect(got!.lots[0]!.amount).toBe(1000n);
  });

  it('persists audit log entries', async () => {
    const store = new FilePortfolioStore({ dir });
    await store._auditForTest(wallet, { ts: 0, event: 'apply', meta: { sig: 's1' } });
    const entries = await store.readAudit(wallet);
    expect(entries).toHaveLength(1);
  });

  it('serializes bigint amounts losslessly', async () => {
    const store = new FilePortfolioStore({ dir });
    const big = 18_446_744_073_709_551_615n; // u64 max
    await store._upsertForTest({
      mint, walletAddress: wallet, lastUpdatedSlot: 1,
      lots: [{ amount: big, costBasisLamports: big, acquiredSlot: 1, acquiredSig: 's', source: 'trade' }],
    });
    const got = await store.getPosition(wallet, mint);
    expect(got!.lots[0]!.amount).toBe(big);
    expect(got!.lots[0]!.costBasisLamports).toBe(big);
  });
});

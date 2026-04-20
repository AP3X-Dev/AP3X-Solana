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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublicKey } from '@ap3x/solana-core';
import { FilePortfolioStore } from '@ap3x/solana-portfolio';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-apply-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('applyLandedTrade', () => {
  it('adds a Lot when amountDelta > 0', async () => {
    const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = new FilePortfolioStore({ dir });
    const changes = await store.applyLandedTrade({
      signature: 's1', slot: 100, wallet, mint,
      amountDelta: 100n, solFlowLamports: -1000n, feeLamports: 5000n, source: 'executor',
    });
    const pos = await store.getPosition(wallet, mint);
    expect(pos!.lots).toHaveLength(1);
    expect(pos!.lots[0]!.amount).toBe(100n);
    expect(pos!.lots[0]!.costBasisLamports).toBe(1000n);
    expect(changes).toHaveLength(1);
  });

  it('reduces lots FIFO when amountDelta < 0', async () => {
    const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = new FilePortfolioStore({ dir });
    await store.applyLandedTrade({ signature: 's1', slot: 100, wallet, mint, amountDelta: 100n, solFlowLamports: -1000n, feeLamports: 5000n, source: 'executor' });
    await store.applyLandedTrade({ signature: 's2', slot: 101, wallet, mint, amountDelta: -50n, solFlowLamports: 800n, feeLamports: 5000n, source: 'executor' });
    const pos = await store.getPosition(wallet, mint);
    expect(pos!.lots[0]!.amount).toBe(50n);
  });
});

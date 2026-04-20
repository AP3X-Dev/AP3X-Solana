import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PublicKey } from '@ap3x/solana-core';
import { FilePortfolioStore } from './store-file.js';

// Resolve the package root regardless of where Vitest is invoked from.
const __filename = fileURLToPath(import.meta.url);
const pkgRoot = path.resolve(path.dirname(__filename), '..');

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-cli-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('cli correct-basis', () => {
  it('updates a lot basis and writes audit', async () => {
    const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = new FilePortfolioStore({ dir });
    await store._upsertForTest({
      mint, walletAddress: wallet, lastUpdatedSlot: 0,
      lots: [{ amount: 100n, costBasisLamports: 0n, acquiredSlot: 1, acquiredSig: 's', source: 'cold-start-unresolved', basisUnresolved: true }],
    });
    execSync(`node dist/cli.js correct-basis ${wallet.toBase58()} ${mint.toBase58()} 0 5000 --dir ${dir}`, {
      cwd: pkgRoot,
    });
    const got = await store.getPosition(wallet, mint);
    expect(got!.lots[0]!.costBasisLamports).toBe(5000n);
    expect(got!.lots[0]!.basisUnresolved).toBe(false);
    const audit = await store.readAudit(wallet);
    expect(audit[0]!.event).toBe('manual-correction');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublicKey } from '@ap3x/solana-core';
import { writeDailyClose } from './daily-close.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-daily-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('writeDailyClose', () => {
  it('appends a JSON line per call', async () => {
    const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
    await writeDailyClose({ dir, wallet, ts: 1234, positions: [], realizedPnl: 100n });
    await writeDailyClose({ dir, wallet, ts: 5678, positions: [], realizedPnl: 200n });
    const file = path.join(dir, `${wallet.toBase58()}.daily.jsonl`);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).ts).toBe(1234);
  });
});

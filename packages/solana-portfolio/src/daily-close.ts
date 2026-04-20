import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PublicKey } from '@ap3x/solana-core';
import type { Position } from './types.js';

export interface WriteDailyCloseOpts {
  dir: string;
  wallet: PublicKey;
  ts: number;
  positions: Position[];
  realizedPnl: bigint;
}

export async function writeDailyClose(opts: WriteDailyCloseOpts): Promise<void> {
  await fs.mkdir(opts.dir, { recursive: true });
  const file = path.join(opts.dir, `${opts.wallet.toBase58()}.daily.jsonl`);
  const line = JSON.stringify({
    ts: opts.ts,
    realizedPnl: opts.realizedPnl.toString(),
    positions: opts.positions.map((p) => ({
      mint: p.mint.toBase58(),
      totalAmount: p.lots.reduce((s, l) => s + l.amount, 0n).toString(),
      totalCostBasis: p.lots.reduce((s, l) => s + l.costBasisLamports, 0n).toString(),
    })),
  });
  await fs.appendFile(file, line + '\n');
}

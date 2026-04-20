#!/usr/bin/env node
import { PublicKey } from '@ap3x/solana-core';
import { FilePortfolioStore } from './store-file.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd !== 'correct-basis') {
    console.error('usage: ap3x-portfolio correct-basis <wallet> <mint> <lotIndex> <costBasisLamports> [--dir <path>]');
    process.exit(2);
  }
  const [walletStr, mintStr, lotIdxStr, basisStr, ...rest] = args;
  const dirIdx = rest.indexOf('--dir');
  const dir = dirIdx >= 0 ? rest[dirIdx + 1] : undefined;
  const wallet = PublicKey.fromBase58(walletStr!);
  const mint = PublicKey.fromBase58(mintStr!);
  const lotIdx = Number(lotIdxStr);
  const basis = BigInt(basisStr!);

  const store = new FilePortfolioStore(dir ? { dir } : {});
  const pos = await store.getPosition(wallet, mint);
  if (!pos) { console.error('no position'); process.exit(1); }
  if (lotIdx < 0 || lotIdx >= pos.lots.length) { console.error('lot index out of range'); process.exit(1); }
  const oldBasis = pos.lots[lotIdx]!.costBasisLamports;
  pos.lots[lotIdx] = { ...pos.lots[lotIdx]!, costBasisLamports: basis, basisUnresolved: false };
  await store._upsertForTest(pos);
  await store._auditForTest(wallet, {
    ts: Date.now(),
    event: 'manual-correction',
    meta: { mint: mint.toBase58(), lotIndex: lotIdx, oldBasis: oldBasis.toString(), newBasis: basis.toString() },
  });
  console.log(`updated lot ${lotIdx} basis: ${oldBasis} → ${basis}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

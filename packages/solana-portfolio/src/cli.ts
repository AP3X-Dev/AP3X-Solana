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
  const { oldBasis } = await store.correctLotBasis(wallet, mint, lotIdx, basis);
  console.log(`updated lot ${lotIdx} basis: ${oldBasis} → ${basis}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

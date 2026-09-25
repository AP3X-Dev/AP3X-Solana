/* eslint-disable */
/**
 * Captures one real mainnet transaction per pump.fun event variant across both
 * programs (bonding curve 6EF8…F6P and PumpSwap pAMM…EA) and writes
 * packages/pumpfun-events/tests/fixtures/pumpfun-per-variant.jsonl.gz.
 *
 * Every transaction found is decoded with both decoders, so a scan of any
 * address can pick up variants from either program. Rare variants are easiest
 * to find by scanning an address that only sees them — e.g. the migration
 * authority for `complete_pump_amm_migration` / `create_pool`, or a graduated
 * mint's bonding curve for `complete`.
 *
 * Existing fixture lines are kept unless a variant is re-captured.
 *
 * Fixture shape (one JSON object per line):
 *   { programId, signature, slot, blockTime, logs: string[], variantHint }
 *
 * Env:
 *   RPC_URL         RPC endpoint (see ./_rpc.ts for the default)
 *   SCAN_ADDRESSES  comma-separated addresses to scan (default: both programs)
 *   MAX_SCAN        max transactions fetched per address (default 2000)
 *
 * Usage: pnpm capture:pumpfun-per-variant
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseLogs, walkInvocations } from '@ap3x/solana-events';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
  bondingCurveDecoder,
  pumpSwapDecoder,
} from '@ap3x/pumpfun-events';
import { rpc, signatures } from './_rpc.js';

const OUT_PATH = 'packages/pumpfun-events/tests/fixtures/pumpfun-per-variant.jsonl.gz';

const VARIANTS = [
  'pumpfun.create',
  'pumpfun.trade',
  'pumpfun.complete',
  'pumpfun.complete_pump_amm_migration',
  'pumpfun.collect_creator_fee',
  'pumpswap.buy',
  'pumpswap.sell',
  'pumpswap.deposit',
  'pumpswap.withdraw',
  'pumpswap.create_pool',
];

const BC = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
const PS = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();

interface FixtureLine {
  programId: string;
  variantHint: string;
  signature: string;
  slot: number;
  blockTime: number;
  logs: string[];
}

function variantsIn(logs: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { chunk } of walkInvocations(parseLogs(logs))) {
    const decoder =
      chunk.programId === BC
        ? bondingCurveDecoder
        : chunk.programId === PS
          ? pumpSwapDecoder
          : null;
    if (!decoder) continue;
    for (const decoded of decoder.decodeAll(chunk)) {
      if (VARIANTS.includes(decoded.kind)) found.set(decoded.kind, chunk.programId);
    }
  }
  return found;
}

async function scan(
  address: string,
  seen: Map<string, FixtureLine>,
  maxScan: number,
  save: () => void,
) {
  for await (const sig of signatures(address, maxScan)) {
    if (seen.size === VARIANTS.length) return;
    if (sig.err) continue;
    const tx = (await rpc('getTransaction', [
      sig.signature,
      { maxSupportedTransactionVersion: 1 },
    ])) as { meta?: { logMessages?: string[] } | null } | null;
    const logs = tx?.meta?.logMessages;
    if (!logs) continue;
    for (const [variantHint, programId] of variantsIn(logs)) {
      if (seen.has(variantHint)) continue;
      seen.set(variantHint, {
        programId,
        variantHint,
        signature: sig.signature,
        slot: sig.slot,
        blockTime: sig.blockTime ?? 0,
        logs,
      });
      console.log(`captured ${variantHint} @ slot ${sig.slot}`);
      save();
    }
  }
}

async function main(): Promise<void> {
  const addresses = (process.env['SCAN_ADDRESSES'] ?? `${BC},${PS}`).split(',').filter(Boolean);
  const maxScan = Number(process.env['MAX_SCAN'] ?? 2_000);

  const kept = new Map<string, FixtureLine>();
  if (existsSync(OUT_PATH)) {
    for (const l of gunzipSync(readFileSync(OUT_PATH))
      .toString('utf-8')
      .split('\n')
      .filter(Boolean)) {
      const line = JSON.parse(l) as FixtureLine;
      if (VARIANTS.includes(line.variantHint)) kept.set(line.variantHint, line);
    }
  }

  const seen = new Map<string, FixtureLine>();
  const merged = () => new Map([...kept, ...seen]);
  const save = () => {
    const all = merged();
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    const ordered = VARIANTS.filter((v) => all.has(v)).map((v) => JSON.stringify(all.get(v)));
    writeFileSync(OUT_PATH, gzipSync(Buffer.from(ordered.join('\n') + '\n', 'utf-8')));
  };
  for (const address of addresses) await scan(address, seen, maxScan, save);
  save();

  const missing = VARIANTS.filter((v) => !merged().has(v));
  console.log(`wrote ${merged().size}/${VARIANTS.length} variants to ${OUT_PATH}`);
  if (missing.length > 0) {
    console.warn(`missing variants: ${missing.join(', ')}. Scan more addresses or raise MAX_SCAN.`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

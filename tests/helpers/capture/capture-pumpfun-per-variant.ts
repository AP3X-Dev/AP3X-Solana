/* eslint-disable */
/**
 * Captures one real event per pump.fun variant (bonding curve program only
 * in this pass — PumpSwap variants are added in T5 once the PumpSwap decoder
 * lands). Writes tests/fixtures/pumpfun-per-variant.jsonl.gz.
 *
 * Helius free tier is sufficient (getSignaturesForAddress + getTransaction).
 * Run once; commit the resulting .jsonl.gz.
 *
 * Fixture shape (one JSON object per line):
 *   { programId, signature, slot, blockTime, logs: string[], variantHint }
 *
 * Self-skip: when HELIUS_API_KEY is unset, prints a skip notice and exits 0.
 * The per-variant test (Task 6) self-skips when the fixture is absent, matching
 * the PRP-02 gate-8 B12 fallback pattern.
 *
 * Usage: HELIUS_API_KEY=xxx pnpm capture:pumpfun-per-variant
 */

import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

import { RpcPool } from '@ap3x/solana-connectivity';
import { parseLogs } from '@ap3x/solana-events';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  bondingCurveDecoder,
} from '@ap3x/pumpfun-events';

const OUT_PATH = 'tests/fixtures/pumpfun-per-variant.jsonl.gz';
const WANTED_VARIANTS = [
  'pumpfun.create',
  'pumpfun.trade',
  'pumpfun.complete',
  'pumpfun.set_params',
  'pumpfun.creator_fee',
  'pumpfun.migrate',
];

// ---------------------------------------------------------------------------
// Minimal typed views over the RPC responses. The RpcPool returns `unknown`
// (see packages/solana-connectivity/src/rpc-pool.ts — RpcResultOf<_M> = unknown),
// so we cast at the call sites rather than invent typed RpcMethod entries.
// ---------------------------------------------------------------------------

interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

interface TransactionResponse {
  meta?: {
    logMessages?: string[];
  } | null;
}

async function main(): Promise<void> {
  const apiKey = process.env['HELIUS_API_KEY'];
  if (!apiKey) {
    console.log(
      'HELIUS_API_KEY not set — skipping capture. Gate tests will self-skip gracefully.',
    );
    return;
  }

  const pool = new RpcPool({
    endpoints: [
      {
        name: 'helius',
        kind: 'http',
        url: `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      },
    ],
    timeoutMs: 30_000,
  });

  const programId = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();

  const seen = new Map<
    string,
    { signature: string; slot: number; blockTime: number; logs: string[] }
  >();
  let cursor: string | undefined;
  const maxScan = 50_000;
  let scanned = 0;

  while (seen.size < WANTED_VARIANTS.length && scanned < maxScan) {
    const sigs = (await pool.call('getSignaturesForAddress', [
      programId,
      { limit: 1000, before: cursor },
    ])) as SignatureInfo[];
    if (sigs.length === 0) break;

    for (const sig of sigs) {
      scanned++;
      if (seen.size === WANTED_VARIANTS.length) break;

      const tx = (await pool.call('getTransaction', [
        sig.signature,
        { maxSupportedTransactionVersion: 0 },
      ])) as TransactionResponse | null;
      if (!tx?.meta?.logMessages) continue;

      const parsed = parseLogs(tx.meta.logMessages);
      for (const chunk of parsed.chunks) {
        if (chunk.programId !== programId) continue;
        const decoded = bondingCurveDecoder.decode(chunk);
        if (decoded.kind === 'unknown') continue;
        if (seen.has(decoded.kind)) continue;
        seen.set(decoded.kind, {
          signature: sig.signature,
          slot: sig.slot,
          blockTime: sig.blockTime ?? 0,
          logs: tx.meta.logMessages,
        });
        console.log(`captured ${decoded.kind} @ slot ${sig.slot}`);
      }
    }

    cursor = sigs[sigs.length - 1]?.signature;
  }

  const lines: string[] = [];
  for (const [variantHint, entry] of seen) {
    lines.push(
      JSON.stringify({
        programId,
        variantHint,
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime,
        logs: entry.logs,
      }),
    );
  }
  const serialized = lines.join('\n') + '\n';
  writeFileSync(OUT_PATH, gzipSync(Buffer.from(serialized, 'utf-8')));
  console.log(`wrote ${seen.size}/${WANTED_VARIANTS.length} variants to ${OUT_PATH}`);

  const missing = WANTED_VARIANTS.filter((v) => !seen.has(v));
  if (missing.length > 0) {
    console.warn(
      `missing variants: ${missing.join(', ')}. Rerun with a wider scan window.`,
    );
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

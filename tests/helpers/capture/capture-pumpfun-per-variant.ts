/* eslint-disable */
/**
 * Captures one real event per pump.fun variant across BOTH programs:
 *   - Bonding curve: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P (6 variants)
 *   - PumpSwap AMM:  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA  (4 variants)
 *
 * Writes tests/fixtures/pumpfun-per-variant.jsonl.gz.
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
import type { ProgramDecoder, UnknownEventDecode } from '@ap3x/solana-events';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
  bondingCurveDecoder,
  pumpSwapDecoder,
} from '@ap3x/pumpfun-events';

const OUT_PATH = 'tests/fixtures/pumpfun-per-variant.jsonl.gz';

const BONDING_CURVE_VARIANTS = [
  'pumpfun.create',
  'pumpfun.trade',
  'pumpfun.complete',
  'pumpfun.set_params',
  'pumpfun.creator_fee',
  'pumpfun.migrate',
];

const PUMPSWAP_VARIANTS = [
  'pumpfun.swap',
  'pumpfun.add_liquidity',
  'pumpfun.remove_liquidity',
  'pumpfun.admin_set_params',
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

interface CapturedEntry {
  signature: string;
  slot: number;
  blockTime: number;
  logs: string[];
}

interface DecoderLike {
  decode(chunk: Parameters<ProgramDecoder<unknown>['decode']>[0]):
    | { kind: string }
    | UnknownEventDecode;
}

async function scanProgram(
  pool: RpcPool,
  programId: string,
  wantedVariants: string[],
  decoder: DecoderLike,
  maxScan: number,
): Promise<Map<string, CapturedEntry>> {
  const seen = new Map<string, CapturedEntry>();
  let cursor: string | undefined;
  let scanned = 0;

  while (seen.size < wantedVariants.length && scanned < maxScan) {
    const sigs = (await pool.call('getSignaturesForAddress', [
      programId,
      { limit: 1000, before: cursor },
    ])) as SignatureInfo[];
    if (sigs.length === 0) break;

    for (const sig of sigs) {
      scanned++;
      if (seen.size === wantedVariants.length) break;

      const tx = (await pool.call('getTransaction', [
        sig.signature,
        { maxSupportedTransactionVersion: 0 },
      ])) as TransactionResponse | null;
      if (!tx?.meta?.logMessages) continue;

      const parsed = parseLogs(tx.meta.logMessages);
      for (const chunk of parsed.chunks) {
        if (chunk.programId !== programId) continue;
        const decoded = decoder.decode(chunk);
        if (decoded.kind === 'unknown') continue;
        if (!wantedVariants.includes(decoded.kind)) continue;
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

  return seen;
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

  const bondingCurveProgramId = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
  const pumpSwapProgramId = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();

  const bondingCurveSeen = await scanProgram(
    pool,
    bondingCurveProgramId,
    BONDING_CURVE_VARIANTS,
    bondingCurveDecoder as DecoderLike,
    50_000,
  );

  const pumpSwapSeen = await scanProgram(
    pool,
    pumpSwapProgramId,
    PUMPSWAP_VARIANTS,
    pumpSwapDecoder as DecoderLike,
    50_000,
  );

  const lines: string[] = [];
  for (const [variantHint, entry] of bondingCurveSeen) {
    lines.push(
      JSON.stringify({
        programId: bondingCurveProgramId,
        variantHint,
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime,
        logs: entry.logs,
      }),
    );
  }
  for (const [variantHint, entry] of pumpSwapSeen) {
    lines.push(
      JSON.stringify({
        programId: pumpSwapProgramId,
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

  const totalCaptured = bondingCurveSeen.size + pumpSwapSeen.size;
  const totalWanted = BONDING_CURVE_VARIANTS.length + PUMPSWAP_VARIANTS.length;
  console.log(
    `wrote ${totalCaptured}/${totalWanted} variants to ${OUT_PATH} ` +
      `(bonding-curve: ${bondingCurveSeen.size}/${BONDING_CURVE_VARIANTS.length}, ` +
      `pumpswap: ${pumpSwapSeen.size}/${PUMPSWAP_VARIANTS.length})`,
  );

  const missingBondingCurve = BONDING_CURVE_VARIANTS.filter((v) => !bondingCurveSeen.has(v));
  const missingPumpSwap = PUMPSWAP_VARIANTS.filter((v) => !pumpSwapSeen.has(v));
  const missing = [...missingBondingCurve, ...missingPumpSwap];
  if (missing.length > 0) {
    console.warn(
      `missing variants: ${missing.join(', ')}. Rerun with a wider scan window. ` +
        `Note: PumpSwap discriminators in discriminator.ts are unverified — if all ` +
        `PumpSwap variants are missing, the placeholder hex values are wrong; ` +
        `update them from a captured sample.`,
    );
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

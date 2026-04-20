/* eslint-disable */
/**
 * Captures full-lifecycle traces for 2-3 pump.fun tokens that graduated from
 * the bonding curve to PumpSwap. For each graduated mint the script walks:
 *
 *   1. Every signature that touches the bonding curve PDA, back to Create.
 *   2. Every signature that touches the PumpSwap pool PDA, forward from
 *      Migrate for a bounded window (default 24 hours).
 *
 * Writes one fixture line per touching transaction into
 * `tests/fixtures/pumpfun-lifecycle.jsonl.gz`:
 *
 *   { programId, signature, slot, blockTime, mintHint: <base58>, logs: string[] }
 *
 * Helius free tier is sufficient (getSignaturesForAddress + getTransaction).
 * Run once; commit the resulting .jsonl.gz.
 *
 * Self-skip: when HELIUS_API_KEY is unset, prints a skip notice and exits 0.
 * The lifecycle test (Task 19) self-skips when the fixture is absent, matching
 * the per-variant fallback pattern from Task 4 / Task 6.
 *
 * Usage: HELIUS_API_KEY=xxx pnpm capture:pumpfun-lifecycle
 */

import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

import { RpcPool } from '@ap3x/solana-connectivity';
import { parseLogs } from '@ap3x/solana-events';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
  bondingCurveDecoder,
} from '@ap3x/pumpfun-events';

const OUT_PATH = 'tests/fixtures/pumpfun-lifecycle.jsonl.gz';

// How many graduated mints to trace.
const TARGET_MINTS = 3;

// Upper bound on signatures scanned while searching for Migrate events.
const MIGRATE_SCAN_LIMIT = 50_000;

// Upper bound on signatures walked per PDA while building a trace.
const PER_PDA_SCAN_LIMIT = 20_000;

// Window after Migrate for which PumpSwap activity is captured, in seconds.
// 24 hours gives enough post-graduation swaps to exercise the decoder, while
// keeping the fixture size manageable.
const POST_MIGRATE_WINDOW_SECS = 24 * 60 * 60;

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
  slot?: number;
  blockTime?: number | null;
}

interface MigrateHit {
  signature: string;
  slot: number;
  blockTime: number;
  mint: string;
  bondingCurve: string;
  pool: string;
}

interface CapturedLine {
  programId: string;
  signature: string;
  slot: number;
  blockTime: number;
  mintHint: string;
  logs: string[];
}

async function findGraduatedMints(pool: RpcPool): Promise<MigrateHit[]> {
  const bondingCurveProgramId = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
  const hits: MigrateHit[] = [];
  const seenMints = new Set<string>();
  let cursor: string | undefined;
  let scanned = 0;

  while (hits.length < TARGET_MINTS && scanned < MIGRATE_SCAN_LIMIT) {
    const sigs = (await pool.call('getSignaturesForAddress', [
      bondingCurveProgramId,
      { limit: 1000, before: cursor },
    ])) as SignatureInfo[];
    if (sigs.length === 0) break;

    for (const sig of sigs) {
      scanned++;
      if (hits.length >= TARGET_MINTS) break;
      if (sig.err !== null) continue;

      const tx = (await pool.call('getTransaction', [
        sig.signature,
        { maxSupportedTransactionVersion: 0 },
      ])) as TransactionResponse | null;
      if (!tx?.meta?.logMessages) continue;

      const parsed = parseLogs(tx.meta.logMessages);
      for (const chunk of parsed.chunks) {
        if (chunk.programId !== bondingCurveProgramId) continue;
        const decoded = bondingCurveDecoder.decode(chunk);
        if (decoded.kind !== 'pumpfun.migrate') continue;
        const mint = decoded.mint.toBase58();
        if (seenMints.has(mint)) continue;
        seenMints.add(mint);
        hits.push({
          signature: sig.signature,
          slot: sig.slot,
          blockTime: sig.blockTime ?? 0,
          mint,
          bondingCurve: decoded.bondingCurve.toBase58(),
          pool: decoded.pool.toBase58(),
        });
        console.log(
          `graduated mint ${mint} (bonding curve ${decoded.bondingCurve.toBase58()}, pool ${decoded.pool.toBase58()}) ` +
            `migrate sig ${sig.signature} slot ${sig.slot}`,
        );
        break;
      }
    }

    cursor = sigs[sigs.length - 1]?.signature;
  }

  return hits;
}

async function collectSignatures(
  pool: RpcPool,
  address: string,
  options: {
    maxScan: number;
    stopBeforeSlot?: number;
    stopAfterBlockTime?: number;
  },
): Promise<SignatureInfo[]> {
  const out: SignatureInfo[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  let stop = false;

  while (!stop && scanned < options.maxScan) {
    const batch = (await pool.call('getSignaturesForAddress', [
      address,
      { limit: 1000, before: cursor },
    ])) as SignatureInfo[];
    if (batch.length === 0) break;

    for (const sig of batch) {
      scanned++;
      // `getSignaturesForAddress` returns newest-first; apply lower bounds by
      // halting once we pass them. `stopBeforeSlot` halts when we reach slots
      // at or older than a given slot. `stopAfterBlockTime` halts when the
      // block time becomes older than the window end (used for the
      // post-migrate window which is defined in forward time but walked
      // backwards from "newest first").
      if (options.stopBeforeSlot !== undefined && sig.slot < options.stopBeforeSlot) {
        stop = true;
        break;
      }
      if (
        options.stopAfterBlockTime !== undefined &&
        sig.blockTime !== null &&
        sig.blockTime < options.stopAfterBlockTime
      ) {
        stop = true;
        break;
      }
      out.push(sig);
    }

    cursor = batch[batch.length - 1]?.signature;
  }

  return out;
}

async function captureTracesForMint(
  pool: RpcPool,
  hit: MigrateHit,
): Promise<CapturedLine[]> {
  const bondingCurveProgramId = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
  const pumpSwapProgramId = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();

  console.log(`tracing bonding curve PDA ${hit.bondingCurve} for mint ${hit.mint}`);
  const bondingCurveSigs = await collectSignatures(pool, hit.bondingCurve, {
    maxScan: PER_PDA_SCAN_LIMIT,
  });

  const postMigrateCutoff =
    hit.blockTime > 0 ? hit.blockTime + POST_MIGRATE_WINDOW_SECS : undefined;

  console.log(`tracing PumpSwap pool PDA ${hit.pool} for mint ${hit.mint}`);
  const pumpSwapSigs = await collectSignatures(pool, hit.pool, {
    maxScan: PER_PDA_SCAN_LIMIT,
    stopAfterBlockTime: hit.blockTime > 0 ? hit.blockTime : undefined,
  });

  // Keep only post-migrate pool activity within the capture window.
  const filteredPumpSwapSigs = pumpSwapSigs.filter((s) => {
    if (s.blockTime === null) return true;
    if (s.blockTime < hit.blockTime) return false;
    if (postMigrateCutoff !== undefined && s.blockTime > postMigrateCutoff) return false;
    return true;
  });

  const allSigs: Array<{ sig: SignatureInfo; programId: string }> = [
    ...bondingCurveSigs.map((sig) => ({ sig, programId: bondingCurveProgramId })),
    ...filteredPumpSwapSigs.map((sig) => ({ sig, programId: pumpSwapProgramId })),
  ];

  console.log(
    `mint ${hit.mint}: ${bondingCurveSigs.length} bonding-curve sigs, ` +
      `${filteredPumpSwapSigs.length} pumpswap sigs → fetching transactions`,
  );

  const lines: CapturedLine[] = [];
  const seenSig = new Set<string>();
  for (const { sig, programId } of allSigs) {
    if (seenSig.has(sig.signature)) continue;
    seenSig.add(sig.signature);
    if (sig.err !== null) continue;

    const tx = (await pool.call('getTransaction', [
      sig.signature,
      { maxSupportedTransactionVersion: 0 },
    ])) as TransactionResponse | null;
    if (!tx?.meta?.logMessages) continue;

    lines.push({
      programId,
      signature: sig.signature,
      slot: sig.slot,
      blockTime: sig.blockTime ?? 0,
      mintHint: hit.mint,
      logs: tx.meta.logMessages,
    });
  }

  console.log(`mint ${hit.mint}: captured ${lines.length} touching transactions`);
  return lines;
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

  const graduated = await findGraduatedMints(pool);
  if (graduated.length === 0) {
    console.warn(
      'No graduated mints found within scan window. Rerun with a wider ' +
        'MIGRATE_SCAN_LIMIT or ensure the bonding-curve Migrate discriminator ' +
        'is still correct.',
    );
    process.exitCode = 2;
    return;
  }

  const allLines: CapturedLine[] = [];
  for (const hit of graduated) {
    const lines = await captureTracesForMint(pool, hit);
    allLines.push(...lines);
  }

  if (allLines.length === 0) {
    console.warn('Captured 0 touching transactions across all mints.');
    process.exitCode = 2;
    return;
  }

  const serialized = allLines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(OUT_PATH, gzipSync(Buffer.from(serialized, 'utf-8')));
  console.log(
    `wrote ${allLines.length} lines across ${graduated.length} mints to ${OUT_PATH}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

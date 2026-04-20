/* eslint-disable */
/**
 * Nightly pump.fun diag probe.
 *
 * Fetches a small sample (~20 recent signatures) from each pump.fun program,
 * pulls each transaction's logs, runs both decoders, and computes the ratio
 * of `UnknownEventDecode` outputs to total decoded chunks per program.
 *
 *   - Fails the run (exit 1) when the unknown ratio exceeds 10% on a program
 *     we know has observed variants. This surfaces pump.fun program upgrades
 *     that change discriminators or layouts before production breaks.
 *   - Self-skips (exit 0) when HELIUS_API_KEY is unset, matching the capture
 *     script pattern used across the repo. Keeps the scheduled CI job
 *     resilient to secret rotation windows.
 *
 * Wiring: run via `pnpm --filter @ap3x/pumpfun-events run diag`. The nightly
 * job in `.github/workflows/ci.yml` (`pumpfun-nightly-diag`) invokes it on a
 * 05:17 UTC cron and injects HELIUS_API_KEY from the repo secrets store.
 *
 * Remediation when this fails: see docs/runbook/pumpfun-fixture-refresh.md.
 */

import { RpcPool } from '@ap3x/solana-connectivity';
import { parseLogs } from '@ap3x/solana-events';
import type { ProgramDecoder, UnknownEventDecode } from '@ap3x/solana-events';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
  bondingCurveDecoder,
  pumpSwapDecoder,
} from '@ap3x/pumpfun-events';

const SAMPLE_TXS_PER_PROGRAM = 20;
const UNKNOWN_RATIO_THRESHOLD = 0.10;

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

interface DecoderLike {
  decode(chunk: Parameters<ProgramDecoder<unknown>['decode']>[0]):
    | { kind: string }
    | UnknownEventDecode;
}

interface ProbeResult {
  programId: string;
  programLabel: string;
  totalChunks: number;
  unknownChunks: number;
  unknownRatio: number;
  txScanned: number;
  breached: boolean;
}

async function probeProgram(
  pool: RpcPool,
  programId: string,
  programLabel: string,
  decoder: DecoderLike,
): Promise<ProbeResult> {
  const sigs = (await pool.call('getSignaturesForAddress', [
    programId,
    { limit: SAMPLE_TXS_PER_PROGRAM },
  ])) as SignatureInfo[];

  let totalChunks = 0;
  let unknownChunks = 0;
  let txScanned = 0;

  for (const sig of sigs) {
    // Skip failed txs — program error paths don't emit the same log schema.
    if (sig.err) continue;
    const tx = (await pool.call('getTransaction', [
      sig.signature,
      { maxSupportedTransactionVersion: 0 },
    ])) as TransactionResponse | null;
    if (!tx?.meta?.logMessages) continue;
    txScanned++;

    const parsed = parseLogs(tx.meta.logMessages);
    for (const chunk of parsed.chunks) {
      if (chunk.programId !== programId) continue;
      totalChunks++;
      const decoded = decoder.decode(chunk);
      if (decoded.kind === 'unknown') {
        unknownChunks++;
      }
    }
  }

  const unknownRatio = totalChunks > 0 ? unknownChunks / totalChunks : 0;
  return {
    programId,
    programLabel,
    totalChunks,
    unknownChunks,
    unknownRatio,
    txScanned,
    breached: unknownRatio > UNKNOWN_RATIO_THRESHOLD && totalChunks > 0,
  };
}

function formatResult(r: ProbeResult): string {
  const pct = (r.unknownRatio * 100).toFixed(1);
  const threshold = (UNKNOWN_RATIO_THRESHOLD * 100).toFixed(0);
  return (
    `${r.programLabel} (${r.programId}): ` +
    `scanned ${r.txScanned} tx, ${r.totalChunks} decoded chunks, ` +
    `${r.unknownChunks} unknown (${pct}%) — ` +
    (r.breached ? `BREACH — exceeds ${threshold}% threshold` : `ok (<= ${threshold}%)`)
  );
}

async function main(): Promise<void> {
  const apiKey = process.env['HELIUS_API_KEY'];
  if (!apiKey) {
    console.log(
      'HELIUS_API_KEY not set — diag probe self-skipping. Rerun with the secret wired to exercise the gate.',
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

  const results: ProbeResult[] = [];
  results.push(
    await probeProgram(
      pool,
      bondingCurveProgramId,
      'bonding-curve',
      bondingCurveDecoder as DecoderLike,
    ),
  );
  results.push(
    await probeProgram(
      pool,
      pumpSwapProgramId,
      'pumpswap',
      pumpSwapDecoder as DecoderLike,
    ),
  );

  console.log('--- pump.fun nightly diag ---');
  for (const r of results) {
    console.log(formatResult(r));
  }

  const breaches = results.filter((r) => r.breached);
  if (breaches.length > 0) {
    console.error('');
    console.error(
      `::error::pump.fun diag breached unknown-ratio threshold on ` +
        `${breaches.length} program(s). Likely program upgrade — rerun capture ` +
        `scripts per docs/runbook/pumpfun-fixture-refresh.md.`,
    );
    process.exitCode = 1;
    return;
  }

  // Soft warning: zero chunks on a program with a wired sample window hints at
  // throttling or rate-limit, not drift. Surface it but don't fail the gate.
  for (const r of results) {
    if (r.totalChunks === 0) {
      console.warn(
        `warning: ${r.programLabel} decoded 0 chunks from ${r.txScanned} tx — ` +
          `possible RPC throttling. Diag did not breach but coverage is thin.`,
      );
    }
  }
}

main().catch((err) => {
  console.error('diag failed with unexpected error:', err);
  process.exitCode = 1;
});

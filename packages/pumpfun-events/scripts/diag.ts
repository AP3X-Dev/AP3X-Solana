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
 *   - Counts event payloads, not invocations: pump.fun's self-CPI event
 *     frames carry no `Program data:` line and are not decode failures.
 *   - Endpoint: RPC_URL, else HELIUS_API_KEY, else the public mainnet RPC
 *     (see tests/helpers/capture/_rpc.ts), with backoff on rate limits.
 *
 * Wiring: run via `pnpm --filter @ap3x/pumpfun-events run diag`. The nightly
 * job in `.github/workflows/ci.yml` (`nightly-diag`) runs it on a 05:17 UTC
 * cron.
 *
 * Remediation when this fails: see docs/runbook/pumpfun-fixture-refresh.md.
 */

import { parseLogs, walkInvocations } from '@ap3x/solana-events';
import type { ProgramDecoder, UnknownEventDecode } from '@ap3x/solana-events';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
  bondingCurveDecoder,
  pumpSwapDecoder,
} from '@ap3x/pumpfun-events';
import { rpc } from '../../../tests/helpers/capture/_rpc.js';

const SAMPLE_TXS_PER_PROGRAM = 60;
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
  decodeAll(chunk: Parameters<ProgramDecoder<unknown>['decode']>[0]): Array<{ kind: string } | UnknownEventDecode>;
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
  programId: string,
  programLabel: string,
  decoder: DecoderLike,
): Promise<ProbeResult> {
  const sigs = (await rpc('getSignaturesForAddress', [
    programId,
    { limit: SAMPLE_TXS_PER_PROGRAM },
  ])) as SignatureInfo[];

  let totalChunks = 0;
  let unknownChunks = 0;
  let txScanned = 0;

  for (const sig of sigs) {
    // Skip failed txs — program error paths don't emit the same log schema.
    if (sig.err) continue;
    const tx = (await rpc('getTransaction', [
      sig.signature,
      { maxSupportedTransactionVersion: 1 },
    ])) as TransactionResponse | null;
    if (!tx?.meta?.logMessages) continue;
    txScanned++;

    const parsed = parseLogs(tx.meta.logMessages);
    for (const { chunk } of walkInvocations(parsed)) {
      if (chunk.programId !== programId || chunk.dataPayloads.length === 0) continue;
      for (const ev of decoder.decodeAll(chunk)) {
        totalChunks++;
        if (ev.kind === 'unknown') unknownChunks++;
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
  const bondingCurveProgramId = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
  const pumpSwapProgramId = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();

  const results: ProbeResult[] = [];
  results.push(
    await probeProgram(
      bondingCurveProgramId,
      'bonding-curve',
      bondingCurveDecoder as DecoderLike,
    ),
  );
  results.push(
    await probeProgram(
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

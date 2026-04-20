/**
 * `fetchRecentTrades` — stateless RPC helper returning recent pump.fun trades
 * for a mint.
 *
 * Composition per round-trip:
 *   1. `getSignaturesForAddress(bondingCurvePda, { limit, before })`
 *      The bonding curve PDA accumulates every pump.fun instruction that
 *      touches the mint — buy, sell, create, complete, migrate. That makes it
 *      a clean single-address subscription point for the pre-graduation life
 *      of the token. Post-graduation swaps appear because the migration
 *      transaction itself lists the curve as an account, and many strategies
 *      poll for enough backfill to catch the boundary.
 *   2. For each signature, `getTransaction(sig, { maxSupportedTransactionVersion: 0 })`.
 *   3. `parseLogs` + `bondingCurveDecoder.decode` / `pumpSwapDecoder.decode`
 *      to turn program log bytes into typed events.
 *   4. Filter to the trade-shaped events (`pumpfun.trade` on the curve,
 *      `pumpfun.swap` on PumpSwap) and annotate each with
 *      `{ signature, slot, blockTime }` so downstream consumers have a
 *      complete record without re-walking the RPC response.
 *
 * Deliberately one-shot — no background subscription, no retry loop. Live
 * streaming is the runtime's `SignalQueue` responsibility; this helper is
 * the cheap "give me the last N" that dashboards, debuggers, and backfill
 * jobs hit directly. Signature of the last element serves as the cursor for
 * subsequent pages via `window.untilSignature`.
 *
 * Advisor-fix: both program-ID base58 strings are captured once at module
 * scope from the real `PublicKey` constants exported by `@ap3x/pumpfun-events`.
 * Under NO circumstances substitute placeholder literals here — drift between
 * the decoder's program ID and the one we compare log chunks against would
 * silently return zero trades for every call.
 */

import type { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import { parseLogs } from '@ap3x/solana-events';
import {
  bondingCurveDecoder,
  pumpSwapDecoder,
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';
import type {
  PumpFunTradeEvent,
  PumpSwapSwapEvent,
} from '@ap3x/pumpfun-events';
import { deriveBondingCurvePda } from './curve/state.js';

/**
 * Base58 program IDs captured once at module load. The `.toBase58()` result
 * is stable across invocations, so caching avoids allocating on every log
 * chunk during a 1000-trade backfill.
 *
 * Advisor-fix: these are real imports, NOT `'PUMPFUN_..._BASE58'` placeholder
 * strings. Keep them real — otherwise the program-ID comparison below
 * silently rejects every log chunk and the function returns `[]` for every
 * mint.
 */
const BONDING_CURVE_PROGRAM_ID_STR = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
const PUMPSWAP_PROGRAM_ID_STR = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();

/**
 * Pagination controls for {@link fetchRecentTrades}.
 *
 *   - `limit` — max signatures to fetch on this round-trip. Maps directly
 *     to `getSignaturesForAddress`'s `limit`; the validator caps it at 1000.
 *   - `untilSignature` — optional "before" cursor. Subsequent pages use the
 *     last-returned signature to walk backwards in time.
 */
export interface RecentTradesWindow {
  limit: number;
  untilSignature?: string;
}

/**
 * A decoded pump.fun or PumpSwap trade event, annotated with the chain
 * locator triple that lets downstream code link it back to a transaction.
 *
 * The union is narrow on purpose: liquidity adds, admin calls, and unknowns
 * are filtered out here because they're not trades — surfacing them through
 * the same type would force every caller to re-discriminate the union.
 */
export type UnifiedTrade = (PumpFunTradeEvent | PumpSwapSwapEvent) & {
  signature: string;
  slot: number;
  blockTime: number;
};

/** Shape of a single entry in `getSignaturesForAddress`'s response array. */
interface SignatureEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
}

/**
 * Shape of the fields we touch on a `getTransaction` response. We only read
 * `meta.logMessages`; everything else (instructions, balances, account keys)
 * is irrelevant to log-driven decoding.
 */
interface TransactionResponse {
  meta?: { logMessages?: string[] } | null;
}

/**
 * Fetch recent pump.fun trades for `mint` via one-shot RPC composition.
 *
 * Returns trades in the order `getSignaturesForAddress` returned them
 * (newest-first by default). Does NOT deduplicate across pages — callers
 * paginating with `window.untilSignature` should drop the cursor's own
 * signature on the second page.
 */
export async function fetchRecentTrades(
  rpcPool: RpcPool,
  mint: PublicKey,
  window: RecentTradesWindow,
): Promise<UnifiedTrade[]> {
  const { address: curvePda } = deriveBondingCurvePda(mint);

  // Build the sigsForAddress config; only include `before` when actually set.
  // Passing `before: undefined` is legal in TS but some validators are fussy
  // about fields whose values are explicit `null`/`undefined`.
  const sigsConfig: Record<string, unknown> = { limit: window.limit };
  if (window.untilSignature !== undefined) {
    sigsConfig.before = window.untilSignature;
  }

  const sigsRaw = (await rpcPool.call('getSignaturesForAddress', [
    curvePda.toBase58(),
    sigsConfig,
  ])) as SignatureEntry[] | null;

  if (!Array.isArray(sigsRaw)) return [];

  const trades: UnifiedTrade[] = [];

  for (const sig of sigsRaw) {
    const tx = (await rpcPool.call('getTransaction', [
      sig.signature,
      { maxSupportedTransactionVersion: 0 },
    ])) as TransactionResponse | null;

    const logMessages = tx?.meta?.logMessages;
    if (!logMessages || logMessages.length === 0) continue;

    const parsed = parseLogs(logMessages);
    for (const chunk of parsed.chunks) {
      let decoded: unknown;
      if (chunk.programId === BONDING_CURVE_PROGRAM_ID_STR) {
        decoded = bondingCurveDecoder.decode(chunk);
      } else if (chunk.programId === PUMPSWAP_PROGRAM_ID_STR) {
        decoded = pumpSwapDecoder.decode(chunk);
      } else {
        continue;
      }

      // The decoder contract returns either a typed event or an
      // UnknownEventDecode (`kind === 'unknown'`). We filter unknowns out here
      // rather than surface them — this helper's job is trades; observability
      // of unknown variants belongs to the registry-based pipeline.
      if (!decoded || typeof decoded !== 'object') continue;
      const kind = (decoded as { kind?: unknown }).kind;
      if (kind !== 'pumpfun.trade' && kind !== 'pumpfun.swap') continue;

      trades.push({
        ...(decoded as PumpFunTradeEvent | PumpSwapSwapEvent),
        signature: sig.signature,
        slot: sig.slot,
        blockTime: sig.blockTime ?? 0,
      });
    }
  }

  return trades;
}

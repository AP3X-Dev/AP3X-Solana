/**
 * PumpSwap AMM math — pure BigInt functions.
 *
 * PumpSwap is the constant-product AMM (`k = x * y`, no virtual offset) that
 * pump.fun tokens migrate to at graduation. Post-graduation strategies price
 * and size fills against this pool rather than the bonding curve. Symmetric
 * to `curve/math.ts`, but simpler: there are no virtual reserves and no
 * graduation progress concept.
 *
 * All arithmetic is done in BigInt against the pool's on-chain reserves:
 *   - `baseReserves`  — raw units of the base mint (typically the pump token, 6 decimals).
 *   - `quoteReserves` — lamports of the quote mint (typically wrapped SOL).
 *
 * Fees are applied in the standard Uniswap-v2 order:
 *   - Buys (quote → base): fee is taken from `quoteIn` before the invariant.
 *   - Sells (base → quote): fee is taken from the pre-fee `quoteOut` after the invariant.
 *
 * The formulas below will be calibrated against real on-chain swaps via the
 * regression suite in `math.test.ts` once the `pumpfun-pumpswap-swaps.json`
 * fixture is captured. Until then the regression suite self-skips and only
 * the synthetic unit tests run.
 */

/** PumpSwap AMM reserves snapshot. Mirrors the reserve fields of {@link PumpSwapPoolState}. */
export interface PumpSwapReserves {
  /** Raw units of the base mint (e.g. the pump token, 6 decimals). */
  baseReserves: bigint;
  /** Lamports of the quote mint (typically wrapped SOL). */
  quoteReserves: bigint;
}

/**
 * Price of 1 base token in quote units (lamports), from pool reserves.
 * Scaled by 1e9 to preserve precision in BigInt arithmetic, matching
 * `priceFromReserves`'s convention in the bonding-curve module.
 */
export function ammPrice(r: PumpSwapReserves): bigint {
  const SCALE = 1_000_000_000n;
  return (r.quoteReserves * SCALE) / r.baseReserves;
}

/**
 * Base tokens received for a given quote-token input, accounting for pool fee.
 * Standard constant-product (`k = x * y`) with fee taken from the input side:
 *   feeAmount     = quoteIn * feeBps / 10000
 *   quoteInAfter  = quoteIn - feeAmount
 *   k             = baseReserves * quoteReserves
 *   newQuote      = quoteReserves + quoteInAfter
 *   newBase       = k / newQuote
 *   tokensOut     = baseReserves - newBase
 */
export function ammTokensOut(
  quoteIn: bigint,
  r: PumpSwapReserves,
  feeBps: number,
): bigint {
  const fee = (quoteIn * BigInt(feeBps)) / 10000n;
  const quoteInAfterFee = quoteIn - fee;
  const k = r.baseReserves * r.quoteReserves;
  const newQuote = r.quoteReserves + quoteInAfterFee;
  const newBase = k / newQuote;
  return r.baseReserves - newBase;
}

/**
 * Quote (SOL) received for a given base-token input, accounting for pool fee.
 * Symmetric to {@link ammTokensOut}, fee taken from the output side:
 *   k              = baseReserves * quoteReserves
 *   newBase        = baseReserves + tokensIn
 *   newQuote       = k / newBase
 *   quoteOutBefore = quoteReserves - newQuote
 *   feeAmount      = quoteOutBefore * feeBps / 10000
 *   quoteOut       = quoteOutBefore - feeAmount
 */
export function ammSolOut(
  tokensIn: bigint,
  r: PumpSwapReserves,
  feeBps: number,
): bigint {
  const k = r.baseReserves * r.quoteReserves;
  const newBase = r.baseReserves + tokensIn;
  const newQuote = k / newBase;
  const quoteOutBeforeFee = r.quoteReserves - newQuote;
  const fee = (quoteOutBeforeFee * BigInt(feeBps)) / 10000n;
  return quoteOutBeforeFee - fee;
}

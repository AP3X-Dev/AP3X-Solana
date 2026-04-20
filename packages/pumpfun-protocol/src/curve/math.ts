/**
 * Pump.fun bonding-curve math — pure BigInt functions.
 *
 * The pump.fun bonding curve is a constant-product AMM with a virtual offset:
 * the program maintains `virtualSolReserves` and `virtualTokenReserves` that
 * define the invariant `k = virtualSol * virtualToken`, separate from the
 * physical `realSolReserves` / `realTokenReserves` actually held in custody.
 *
 * All arithmetic is done in BigInt against lamports (SOL) and raw token units
 * (pump.fun tokens use 6 decimals). Callers convert to human units at the
 * presentation layer.
 *
 * The formulas below (especially `priceFromReserves`'s scaling factor and the
 * order of fee application in `tokensOutForSolIn` / `solOutForTokensIn`) are
 * calibrated against real on-chain trades via the regression suite in
 * `math.test.ts`. If the regression fails after a fixture refresh, the formula
 * is what needs adjusting — not the fixture.
 */

/** Bonding-curve reserves snapshot, matching {@link CurveState}'s reserve fields. */
export interface CurveReserves {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

/**
 * Price of 1 token in lamports, from virtual reserves.
 * Scaled by 1e9 to preserve precision in BigInt arithmetic.
 */
export function priceFromReserves(r: CurveReserves): bigint {
  const SCALE = 1_000_000_000n;
  return (r.virtualSolReserves * SCALE) / r.virtualTokenReserves;
}

/**
 * Tokens received for a given SOL input, accounting for the platform fee.
 * Formula (constant product with virtual offset):
 *   feeAmount = solIn * feeBasisPoints / 10000
 *   solInAfterFee = solIn - feeAmount
 *   newVirtualSol = virtualSolReserves + solInAfterFee
 *   newVirtualToken = (virtualSolReserves * virtualTokenReserves) / newVirtualSol
 *   tokensOut = virtualTokenReserves - newVirtualToken
 */
export function tokensOutForSolIn(solIn: bigint, r: CurveReserves, feeBasisPoints: number): bigint {
  const fee = (solIn * BigInt(feeBasisPoints)) / 10000n;
  const solInAfterFee = solIn - fee;
  const k = r.virtualSolReserves * r.virtualTokenReserves;
  const newVirtualSol = r.virtualSolReserves + solInAfterFee;
  const newVirtualToken = k / newVirtualSol;
  return r.virtualTokenReserves - newVirtualToken;
}

/**
 * SOL received for a given token input, accounting for the platform fee.
 * Formula (symmetric to tokensOutForSolIn):
 */
export function solOutForTokensIn(tokensIn: bigint, r: CurveReserves, feeBasisPoints: number): bigint {
  const k = r.virtualSolReserves * r.virtualTokenReserves;
  const newVirtualToken = r.virtualTokenReserves + tokensIn;
  const newVirtualSol = k / newVirtualToken;
  const solOutBeforeFee = r.virtualSolReserves - newVirtualSol;
  const fee = (solOutBeforeFee * BigInt(feeBasisPoints)) / 10000n;
  return solOutBeforeFee - fee;
}

/**
 * Progress toward graduation. Based on realSolReserves vs threshold (typically 85 SOL).
 * Returns a float in [0, 1).
 */
export function pctToGraduation(r: CurveReserves, graduationSolThreshold: bigint): number {
  if (r.realSolReserves >= graduationSolThreshold) return 1;
  const ratio = Number(r.realSolReserves) / Number(graduationSolThreshold);
  return Math.min(Math.max(ratio, 0), 0.9999);
}

/**
 * Price impact in basis points for a given SOL input.
 *   priceBefore = virtualSol / virtualToken
 *   priceAfter  = newVirtualSol / newVirtualToken (after the hypothetical buy)
 *   bps         = (priceAfter - priceBefore) / priceBefore * 10000
 */
export function priceImpactBps(solIn: bigint, r: CurveReserves): number {
  const priceBefore = priceFromReserves(r);
  const k = r.virtualSolReserves * r.virtualTokenReserves;
  const newVirtualSol = r.virtualSolReserves + solIn;
  const newVirtualToken = k / newVirtualSol;
  const SCALE = 1_000_000_000n;
  const priceAfter = (newVirtualSol * SCALE) / newVirtualToken;
  const delta = priceAfter - priceBefore;
  const bps = Number((delta * 10000n) / priceBefore);
  return bps;
}

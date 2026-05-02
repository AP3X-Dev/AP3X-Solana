/**
 * Walk-forward exit simulation for a single trade.
 *
 * Given a sorted price array, an entry point, and exit rules,
 * walks forward through price observations checking exit conditions
 * in priority order: hard stop > take profit > trailing stop > time limit.
 */

import type { BacktestTrade, ExitRules, PricePoint } from './types.js';

/**
 * Binary search for the first index where points[i].ts >= targetTs.
 * Returns points.length if no such index exists.
 */
export function binarySearchFirstGte(points: readonly PricePoint[], targetTs: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.ts < targetTs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Simulates a single trade from the given entry index through the
 * price series, applying exit rules. Returns the trade result.
 *
 * @param points - sorted price observations for this token
 * @param entryIdx - index into points where entry occurs
 * @param entryPrice - actual entry price (after slippage)
 * @param rules - exit rule parameters
 * @param entryTimeMs - entry timestamp in ms (for hold time calculation)
 * @param exitSlippage - fraction to deduct from exit price (e.g., 0.05 = 5%)
 */
export function walkForwardExit(
  points: readonly PricePoint[],
  entryIdx: number,
  entryPrice: number,
  rules: ExitRules,
  entryTimeMs: number,
  exitSlippage: number,
): BacktestTrade {
  const holdLimitMs = rules.holdMinutes * 60_000;
  const maxExitTime = entryTimeMs + holdLimitMs;
  let peak = points[entryIdx]?.price ?? entryPrice;

  for (let i = entryIdx; i < points.length; i++) {
    const p = points[i]!;

    // Past hold limit — exit at current price
    if (p.ts > maxExitTime) {
      return makeTrade(entryPrice, p.price, exitSlippage, entryTimeMs, p.ts, 'time');
    }

    peak = Math.max(peak, p.price);

    // Hard stop
    if (p.price <= entryPrice * (1 - rules.hardStopPct / 100)) {
      return makeTrade(entryPrice, p.price, exitSlippage, entryTimeMs, p.ts, 'hard_stop');
    }

    // Take profit
    if (p.price >= entryPrice * rules.takeProfitMultiple) {
      return makeTrade(entryPrice, p.price, exitSlippage, entryTimeMs, p.ts, 'take_profit');
    }

    // Trailing stop (only after activation threshold)
    if (peak >= entryPrice * rules.trailingActivationMultiple) {
      if (p.price <= peak * (1 - rules.trailingStopPct / 100)) {
        return makeTrade(entryPrice, p.price, exitSlippage, entryTimeMs, p.ts, 'trailing_stop');
      }
    }
  }

  // Ran out of data
  const last = points[points.length - 1]!;
  return makeTrade(entryPrice, last.price, exitSlippage, entryTimeMs, last.ts, 'end_of_data');
}

function makeTrade(
  entryPrice: number,
  rawExitPrice: number,
  exitSlippage: number,
  entryTimeMs: number,
  exitTimeMs: number,
  exitReason: BacktestTrade['exitReason'],
): BacktestTrade {
  const exitPrice = rawExitPrice * (1 - exitSlippage);
  return {
    entryPrice,
    exitPrice,
    roi: exitPrice / entryPrice,
    holdMinutes: (exitTimeMs - entryTimeMs) / 60_000,
    exitReason,
    entryTimeMs,
    exitTimeMs,
  };
}

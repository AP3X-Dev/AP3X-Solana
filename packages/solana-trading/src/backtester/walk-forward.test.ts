import { describe, it, expect } from 'vitest';
import { binarySearchFirstGte, walkForwardExit } from './walk-forward.js';
import { computeMetrics } from './metrics.js';
import { runMonteCarlo } from './monte-carlo.js';
import type { ExitRules, PricePoint } from './types.js';

const rules: ExitRules = {
  holdMinutes: 60,
  hardStopPct: 50,
  takeProfitMultiple: 2.5,
  trailingStopPct: 30,
  trailingActivationMultiple: 2.0,
};

function makePoints(prices: number[], intervalMs = 60_000): PricePoint[] {
  return prices.map((price, i) => ({ ts: 1000000 + i * intervalMs, price }));
}

describe('binarySearchFirstGte', () => {
  it('finds first index >= target', () => {
    const points = makePoints([1, 2, 3, 4, 5]);
    expect(binarySearchFirstGte(points, 1000000 + 2 * 60_000)).toBe(2);
  });

  it('returns length when target is past all points', () => {
    const points = makePoints([1, 2, 3]);
    expect(binarySearchFirstGte(points, 9999999)).toBe(3);
  });
});

describe('walkForwardExit', () => {
  it('exits on take profit', () => {
    // Price doubles → 2.5x entry triggers TP
    const points = makePoints([1.0, 1.5, 2.0, 2.5, 3.0]);
    const trade = walkForwardExit(points, 0, 1.0, rules, 1000000, 0.05);
    expect(trade.exitReason).toBe('take_profit');
    expect(trade.exitPrice).toBeCloseTo(2.5 * 0.95);
  });

  it('exits on hard stop', () => {
    // Price drops to 0.4 (below 50% stop)
    const points = makePoints([1.0, 0.8, 0.6, 0.4]);
    const trade = walkForwardExit(points, 0, 1.0, rules, 1000000, 0.05);
    expect(trade.exitReason).toBe('hard_stop');
    expect(trade.exitPrice).toBeCloseTo(0.4 * 0.95);
  });

  it('exits on time limit', () => {
    // Price stays flat for 61 minutes
    const points = makePoints(Array(62).fill(1.0) as number[]);
    const trade = walkForwardExit(points, 0, 1.0, rules, 1000000, 0.05);
    expect(trade.exitReason).toBe('time');
    expect(trade.holdMinutes).toBeGreaterThanOrEqual(60);
  });

  it('exits on trailing stop after activation', () => {
    // Price rises to 2.2x (above 2.0x activation but below 2.5x TP), then drops 30%
    const points = makePoints([1.0, 1.5, 2.0, 2.2, 1.8, 1.5]);
    const trade = walkForwardExit(points, 0, 1.0, rules, 1000000, 0.05);
    // Peak = 2.2, trailing triggers at 2.2 * 0.7 = 1.54
    expect(trade.exitReason).toBe('trailing_stop');
    expect(trade.exitPrice).toBeCloseTo(1.5 * 0.95);
  });

  it('does not trigger trailing before activation', () => {
    // Price rises to 1.8x (below 2.0x activation) then drops
    const points = makePoints([1.0, 1.5, 1.8, 1.2, 0.9]);
    const trade = walkForwardExit(points, 0, 1.0, rules, 1000000, 0.05);
    // Should NOT be trailing_stop (not activated), should be hard_stop at 0.5
    // 0.9 > 0.5 so no hard stop yet... wait 0.5 is 50% of 1.0
    // Actually none of these hit hard stop (0.9 > 0.5, 1.2 > 0.5)
    // It should exit on time after 60 min (5 points at 1min intervals = 5min, need more)
    expect(trade.exitReason).toBe('end_of_data');
  });
});

describe('computeMetrics', () => {
  it('computes correct metrics for winning trades', () => {
    const trades = Array(25).fill(null).map((_, i) => ({
      entryPrice: 1.0, exitPrice: 1.8 + i * 0.02, roi: 1.8 + i * 0.02, holdMinutes: 30, exitReason: 'take_profit' as const,
    }));
    const m = computeMetrics(trades, 100);
    expect(m.winRate).toBe(1.0);
    expect(m.meanRoi).toBeGreaterThan(1.5);
    expect(m.sharpeRatio).toBeGreaterThan(1);
    expect(m.tradeCount).toBe(25);
  });

  it('returns -Infinity fitness below minTrades', () => {
    const trades = [{ entryPrice: 1, exitPrice: 2, roi: 2, holdMinutes: 10, exitReason: 'take_profit' as const }];
    const m = computeMetrics(trades, 100, 20);
    expect(m.fitness).toBe(-Infinity);
  });

  it('computes max drawdown correctly', () => {
    const trades = [
      { entryPrice: 1, exitPrice: 2, roi: 2.0, holdMinutes: 10, exitReason: 'take_profit' as const },
      { entryPrice: 1, exitPrice: 0.5, roi: 0.5, holdMinutes: 10, exitReason: 'hard_stop' as const },
    ];
    const m = computeMetrics(trades, 10, 2);
    // Equity: 1 * 2.0 = 2.0 (peak), then 2.0 * 0.5 = 1.0, DD = (2-1)/2 = 50%
    expect(m.maxDrawdown).toBe(0.5);
  });
});

describe('runMonteCarlo', () => {
  it('projects portfolio growth with winning ROI pool', () => {
    const roiPool = [2.0, 2.0, 2.0, 1.5, 1.5]; // all winners
    const holdHours = [1, 1, 1, 1, 1];
    const result = runMonteCarlo(roiPool, holdHours, 10, {
      runs: 100, days: 30, startCapital: 1500, tradeSize: 100, maxConcurrent: 3, seed: 42,
    });
    expect(result.medianFinal).toBeGreaterThan(1500);
    expect(result.medianReturn).toBeGreaterThan(0);
    expect(result.bustRate).toBe(0);
  });

  it('projects bust with losing ROI pool', () => {
    const roiPool = [0.1, 0.1, 0.1, 0.2, 0.2]; // heavy losers
    const holdHours = [1, 1, 1, 1, 1];
    const result = runMonteCarlo(roiPool, holdHours, 10, {
      runs: 100, days: 30, startCapital: 1500, tradeSize: 100, maxConcurrent: 3, seed: 42,
    });
    expect(result.medianFinal).toBeLessThan(500);
    expect(result.bustRate).toBeGreaterThan(50);
  });

  it('is deterministic with same seed', () => {
    const pool = [1.5, 2.0, 0.5, 1.0, 0.8];
    const hold = [1, 2, 1, 1, 3];
    const cfg = { runs: 50, days: 30, startCapital: 1500, tradeSize: 100, maxConcurrent: 3, seed: 99 };
    const r1 = runMonteCarlo(pool, hold, 5, cfg);
    const r2 = runMonteCarlo(pool, hold, 5, cfg);
    expect(r1.medianFinal).toBe(r2.medianFinal);
  });
});

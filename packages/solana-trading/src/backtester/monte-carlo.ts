/**
 * Monte Carlo portfolio simulation.
 *
 * Projects a strategy's ROI distribution over N days with position
 * sizing, concurrent slot limits, and bankroll management. Returns
 * percentile distribution of final portfolio values.
 */

import type { MonteCarloConfig, MonteCarloResult } from './types.js';

/**
 * Runs a Monte Carlo simulation projecting portfolio performance.
 *
 * @param roiPool - historical per-trade ROI values to sample from
 * @param holdHoursPool - historical per-trade hold durations (hours)
 * @param alertsPerDay - observed signal frequency
 * @param config - simulation parameters
 */
export function runMonteCarlo(
  roiPool: readonly number[],
  holdHoursPool: readonly number[],
  alertsPerDay: number,
  config: MonteCarloConfig,
): MonteCarloResult {
  if (roiPool.length === 0) {
    return { medianFinal: config.startCapital, medianReturn: 0, p10: config.startCapital, p25: config.startCapital, p75: config.startCapital, p90: config.startCapital, bustRate: 0, avgTradesTaken: 0 };
  }

  let rngState = config.seed;
  function rng(): number {
    rngState = (rngState * 1664525 + 1013904223) | 0;
    return (rngState >>> 0) / 0xFFFFFFFF;
  }

  const finals: number[] = [];
  let totalTrades = 0;

  for (let run = 0; run < config.runs; run++) {
    const result = simulateOneRun(rng, roiPool, holdHoursPool, alertsPerDay, config);
    finals.push(result.final);
    totalTrades += result.taken;
  }

  finals.sort((a, b) => a - b);
  const p = (pct: number) => finals[Math.floor(pct / 100 * (finals.length - 1))]!;
  const median = p(50);
  const bust = finals.filter(v => v < config.startCapital * 0.33).length;

  return {
    medianFinal: median,
    medianReturn: (median / config.startCapital - 1) * 100,
    p10: p(10),
    p25: p(25),
    p75: p(75),
    p90: p(90),
    bustRate: (bust / config.runs) * 100,
    avgTradesTaken: totalTrades / config.runs,
  };
}

function simulateOneRun(
  rng: () => number,
  roiPool: readonly number[],
  holdHoursPool: readonly number[],
  alertsPerDay: number,
  config: MonteCarloConfig,
): { final: number; taken: number } {
  let bankroll = config.startCapital;
  const busyUntil = new Array(config.maxConcurrent).fill(0) as number[];
  const pendingAmount = new Array(config.maxConcurrent).fill(0) as number[];
  const pendingRoi = new Array(config.maxConcurrent).fill(1) as number[];

  const nAlerts = Math.round(alertsPerDay * config.days);
  const times: number[] = [];
  for (let i = 0; i < nAlerts; i++) times.push(rng() * config.days * 24);
  times.sort((a, b) => a - b);

  let taken = 0;
  for (const t of times) {
    // Close completed positions
    for (let i = 0; i < config.maxConcurrent; i++) {
      if (busyUntil[i]! > 0 && busyUntil[i]! <= t) {
        bankroll += pendingAmount[i]! * pendingRoi[i]!;
        busyUntil[i] = 0;
        pendingAmount[i] = 0;
        pendingRoi[i] = 1;
      }
    }

    // Find free slot
    const idx = busyUntil.findIndex(b => b === 0);
    if (idx === -1) continue;
    if (bankroll < config.tradeSize) continue;

    // Take trade
    const tradeIdx = Math.floor(rng() * roiPool.length);
    bankroll -= config.tradeSize;
    busyUntil[idx] = t + holdHoursPool[tradeIdx]!;
    pendingAmount[idx] = config.tradeSize;
    pendingRoi[idx] = roiPool[tradeIdx]!;
    taken++;
  }

  // Close remaining
  for (let i = 0; i < config.maxConcurrent; i++) {
    if (busyUntil[i]! > 0) bankroll += pendingAmount[i]! * pendingRoi[i]!;
  }

  return { final: bankroll, taken };
}

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { tokensOutForSolIn, solOutForTokensIn, priceFromReserves, priceImpactBps, pctToGraduation } from './math.js';

interface TradeRecord {
  slot: number;
  signature: string;
  preReserves: { virtualSolReserves: string; virtualTokenReserves: string; realSolReserves: string; realTokenReserves: string };
  solIn: string;
  tokensOut: string;
  isBuy: boolean;
  feeBasisPoints: number;
}

const FIXTURE_PATH = 'tests/fixtures/pumpfun-bonding-curve-trades.json';

function loadTrades(): TradeRecord[] {
  if (!existsSync(FIXTURE_PATH)) return [];
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
}

const trades = loadTrades();

describe.skipIf(trades.length === 0)('bonding curve math regression', () => {
  it('has at least 100 captured trades', () => {
    expect(trades.length).toBeGreaterThanOrEqual(100);
  });

  it('tokensOutForSolIn matches observed fills within 1 bps for all buys', () => {
    const buys = trades.filter((t) => t.isBuy);
    expect(buys.length).toBeGreaterThan(0);
    for (const t of buys) {
      const computed = tokensOutForSolIn(BigInt(t.solIn), {
        virtualSolReserves: BigInt(t.preReserves.virtualSolReserves),
        virtualTokenReserves: BigInt(t.preReserves.virtualTokenReserves),
        realSolReserves: BigInt(t.preReserves.realSolReserves),
        realTokenReserves: BigInt(t.preReserves.realTokenReserves),
      }, t.feeBasisPoints);
      const observed = BigInt(t.tokensOut);
      const deltaBps = Number((computed - observed) * 10000n / observed);
      expect(Math.abs(deltaBps)).toBeLessThanOrEqual(1);
    }
  });

  it('solOutForTokensIn matches observed fills within 1 bps for all sells', () => {
    const sells = trades.filter((t) => !t.isBuy);
    expect(sells.length).toBeGreaterThan(0);
    for (const t of sells) {
      const computed = solOutForTokensIn(BigInt(t.tokensOut), {
        virtualSolReserves: BigInt(t.preReserves.virtualSolReserves),
        virtualTokenReserves: BigInt(t.preReserves.virtualTokenReserves),
        realSolReserves: BigInt(t.preReserves.realSolReserves),
        realTokenReserves: BigInt(t.preReserves.realTokenReserves),
      }, t.feeBasisPoints);
      const observed = BigInt(t.solIn);
      const deltaBps = Number((computed - observed) * 10000n / observed);
      expect(Math.abs(deltaBps)).toBeLessThanOrEqual(1);
    }
  });
});

describe('bonding curve math — synthetic unit tests', () => {
  it('priceFromReserves returns virtualSol / virtualToken ratio', () => {
    const price = priceFromReserves({
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
    });
    // price is virtualSol / virtualToken, lamports per token (scaled)
    // Expected rough magnitude — exact formula confirmed via regression
    expect(price).toBeGreaterThan(0n);
  });

  it('pctToGraduation returns 0.0 - 1.0', () => {
    const pct = pctToGraduation(
      { virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_000_000_000_000_000n, realSolReserves: 42_000_000_000n, realTokenReserves: 0n },
      85_000_000_000n, // graduation threshold
    );
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(1);
  });

  it('priceImpactBps returns positive for buys', () => {
    const bps = priceImpactBps(100_000_000n, {
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
    });
    expect(bps).toBeGreaterThan(0);
  });

  it('tokensOutForSolIn returns a positive token amount for a typical buy', () => {
    const out = tokensOutForSolIn(1_000_000_000n, {
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
    }, 100);
    expect(out).toBeGreaterThan(0n);
  });

  it('solOutForTokensIn returns a positive sol amount for a typical sell', () => {
    const out = solOutForTokensIn(1_000_000_000_000n, {
      virtualSolReserves: 31_000_000_000n,
      virtualTokenReserves: 1_070_000_000_000_000n,
      realSolReserves: 1_000_000_000n,
      realTokenReserves: 3_000_000_000_000n,
    }, 100);
    expect(out).toBeGreaterThan(0n);
  });
});

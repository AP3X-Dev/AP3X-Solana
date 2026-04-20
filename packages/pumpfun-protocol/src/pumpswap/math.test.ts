import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { ammPrice, ammTokensOut, ammSolOut } from './math.js';

interface SwapRecord {
  slot: number;
  signature: string;
  preReserves: { baseReserves: string; quoteReserves: string };
  quoteIn: string;
  tokensOut: string;
  isBuy: boolean;
  feeBasisPoints: number;
}

const FIXTURE_PATH = 'tests/fixtures/pumpfun-pumpswap-swaps.json';

function loadSwaps(): SwapRecord[] {
  if (!existsSync(FIXTURE_PATH)) return [];
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
}

const swaps = loadSwaps();

describe.skipIf(swaps.length === 0)('pumpswap AMM math regression', () => {
  it('has at least 100 captured swaps', () => {
    expect(swaps.length).toBeGreaterThanOrEqual(100);
  });

  it('ammTokensOut matches observed fills within 1 bps for all buys', () => {
    const buys = swaps.filter((s) => s.isBuy);
    expect(buys.length).toBeGreaterThan(0);
    for (const s of buys) {
      const computed = ammTokensOut(
        BigInt(s.quoteIn),
        {
          baseReserves: BigInt(s.preReserves.baseReserves),
          quoteReserves: BigInt(s.preReserves.quoteReserves),
        },
        s.feeBasisPoints,
      );
      const observed = BigInt(s.tokensOut);
      const deltaBps = Number(((computed - observed) * 10000n) / observed);
      expect(Math.abs(deltaBps)).toBeLessThanOrEqual(1);
    }
  });

  it('ammSolOut matches observed fills within 1 bps for all sells', () => {
    const sells = swaps.filter((s) => !s.isBuy);
    expect(sells.length).toBeGreaterThan(0);
    for (const s of sells) {
      const computed = ammSolOut(
        BigInt(s.tokensOut),
        {
          baseReserves: BigInt(s.preReserves.baseReserves),
          quoteReserves: BigInt(s.preReserves.quoteReserves),
        },
        s.feeBasisPoints,
      );
      const observed = BigInt(s.quoteIn);
      const deltaBps = Number(((computed - observed) * 10000n) / observed);
      expect(Math.abs(deltaBps)).toBeLessThanOrEqual(1);
    }
  });
});

describe('pumpswap AMM math — synthetic unit tests', () => {
  it('ammPrice returns quote / base ratio, scaled by 1e9', () => {
    const price = ammPrice({
      baseReserves: 1_000_000_000_000n, // 1M base tokens (6 decimals)
      quoteReserves: 100_000_000_000n, // 100 SOL in lamports
    });
    // price = (100e9 * 1e9) / 1e12 = 100e6 scaled lamports per base unit
    expect(price).toBe(100_000_000n);
  });

  it('ammPrice is strictly positive for any non-empty pool', () => {
    const price = ammPrice({
      baseReserves: 1n,
      quoteReserves: 1n,
    });
    expect(price).toBeGreaterThan(0n);
  });

  it('ammTokensOut returns a positive token amount for a typical buy', () => {
    const out = ammTokensOut(
      1_000_000_000n, // 1 SOL in lamports
      {
        baseReserves: 1_000_000_000_000n,
        quoteReserves: 100_000_000_000n,
      },
      30, // 0.30% fee
    );
    expect(out).toBeGreaterThan(0n);
    // Should be less than baseReserves (never drain the pool)
    expect(out).toBeLessThan(1_000_000_000_000n);
  });

  it('ammSolOut returns a positive sol amount for a typical sell', () => {
    const out = ammSolOut(
      10_000_000_000n, // 10k base tokens
      {
        baseReserves: 1_000_000_000_000n,
        quoteReserves: 100_000_000_000n,
      },
      30,
    );
    expect(out).toBeGreaterThan(0n);
    // Should be less than quoteReserves (never drain the pool)
    expect(out).toBeLessThan(100_000_000_000n);
  });

  it('ammTokensOut applies fee — higher fee yields fewer tokens', () => {
    const reserves = {
      baseReserves: 1_000_000_000_000n,
      quoteReserves: 100_000_000_000n,
    };
    const quoteIn = 1_000_000_000n;
    const lowFee = ammTokensOut(quoteIn, reserves, 30); // 0.30%
    const highFee = ammTokensOut(quoteIn, reserves, 300); // 3.00%
    expect(lowFee).toBeGreaterThan(highFee);
  });

  it('ammSolOut applies fee — higher fee yields less sol', () => {
    const reserves = {
      baseReserves: 1_000_000_000_000n,
      quoteReserves: 100_000_000_000n,
    };
    const tokensIn = 10_000_000_000n;
    const lowFee = ammSolOut(tokensIn, reserves, 30);
    const highFee = ammSolOut(tokensIn, reserves, 300);
    expect(lowFee).toBeGreaterThan(highFee);
  });

  it('ammTokensOut respects constant-product invariant (k after post-fee swap within rounding)', () => {
    const reserves = {
      baseReserves: 1_000_000_000_000n,
      quoteReserves: 100_000_000_000n,
    };
    const quoteIn = 1_000_000_000n;
    const feeBps = 30;
    const tokensOut = ammTokensOut(quoteIn, reserves, feeBps);

    // The invariant is evaluated on the fee-excluded swap: post-fee quote add + base removed.
    // Integer-division floor on newBase means kAfter may dip below kBefore by at most
    // one unit of newQuote (the rounding error stays with the trader, not the pool).
    const kBefore = reserves.baseReserves * reserves.quoteReserves;
    const fee = (quoteIn * BigInt(feeBps)) / 10000n;
    const quoteInAfterFee = quoteIn - fee;
    const newBase = reserves.baseReserves - tokensOut;
    const newQuote = reserves.quoteReserves + quoteInAfterFee;
    const kAfter = newBase * newQuote;

    const slack = newQuote; // max floor-division error per Uniswap-v2 invariant analysis
    expect(kAfter).toBeGreaterThanOrEqual(kBefore - slack);
    expect(kAfter).toBeLessThanOrEqual(kBefore);
  });

  it('zero quoteIn yields zero tokens out', () => {
    const out = ammTokensOut(
      0n,
      {
        baseReserves: 1_000_000_000_000n,
        quoteReserves: 100_000_000_000n,
      },
      30,
    );
    expect(out).toBe(0n);
  });

  it('zero tokensIn yields zero sol out', () => {
    const out = ammSolOut(
      0n,
      {
        baseReserves: 1_000_000_000_000n,
        quoteReserves: 100_000_000_000n,
      },
      30,
    );
    expect(out).toBe(0n);
  });
});

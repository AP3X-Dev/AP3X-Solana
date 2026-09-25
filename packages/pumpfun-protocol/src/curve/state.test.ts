import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { bondingCurveBytes, globalBytes, key } from '../_test-accounts.js';
import {
  AccountLayoutError,
  decodeCurveState,
  decodeGlobalState,
  deriveBondingCurvePda,
  deriveBondingCurveV2Pda,
} from './state.js';

const MINT = PublicKey.fromBase58('So11111111111111111111111111111111111111112');

describe('deriveBondingCurvePda', () => {
  it('is deterministic and differs per mint', () => {
    const a = deriveBondingCurvePda(MINT);
    expect(a.address.equals(deriveBondingCurvePda(MINT).address)).toBe(true);
    expect(a.bump).toBeGreaterThanOrEqual(0);
    expect(a.bump).toBeLessThan(256);
    const other = deriveBondingCurvePda(PublicKey.fromBase58('11111111111111111111111111111111'));
    expect(a.address.equals(other.address)).toBe(false);
  });

  it('differs from the bonding-curve-v2 PDA', () => {
    expect(deriveBondingCurvePda(MINT).address.equals(deriveBondingCurveV2Pda(MINT).address)).toBe(false);
  });
});

describe('decodeCurveState', () => {
  it('decodes the current BondingCurve layout', () => {
    const bytes = bondingCurveBytes({
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualQuoteReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: 5_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: true,
      creator: key(7),
      isCashbackCoin: true,
      quoteMint: MINT,
    });
    const s = decodeCurveState(bytes, MINT);
    expect(s).toMatchObject({
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualSolReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realSolReserves: 5_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: true,
      isCashbackCoin: true,
    });
    expect(s.creator.equals(key(7))).toBe(true);
    expect(s.quoteMint?.equals(MINT)).toBe(true);
    expect(s.bondingCurve.equals(deriveBondingCurvePda(MINT).address)).toBe(true);
  });

  it('decodes an older account that ends after `creator`', () => {
    const s = decodeCurveState(bondingCurveBytes({ creator: key(9) }, 7), MINT);
    expect(s.creator.equals(key(9))).toBe(true);
    expect(s.isCashbackCoin).toBe(false);
    expect(s.quoteMint).toBeUndefined();
  });

  it('rejects the wrong account type', () => {
    const bytes = globalBytes({});
    expect(() => decodeCurveState(bytes, MINT)).toThrow(AccountLayoutError);
    expect(() => decodeCurveState(bytes, MINT)).toThrow(/discriminator mismatch/);
  });

  it('rejects a truncated account and keeps the observed bytes', () => {
    const tiny = bondingCurveBytes({}).subarray(0, 20);
    try {
      decodeCurveState(tiny, MINT);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountLayoutError);
      expect((err as AccountLayoutError).expected).toBe('BondingCurve');
      expect((err as AccountLayoutError).observed).toBe(tiny);
    }
  });
});

describe('decodeGlobalState', () => {
  it('returns fee recipients with zero keys removed', () => {
    const g = decodeGlobalState(
      globalBytes({
        feeRecipient: key(1),
        feeBasisPoints: 95n,
        creatorFeeBasisPoints: 30n,
        feeRecipients: [key(2), key(0), key(3), key(0), key(0), key(0), key(0)],
        buybackFeeRecipients: [key(4), key(0), key(0), key(0), key(0), key(0), key(0), key(0)],
      }),
    );
    expect(g.feeRecipient.equals(key(1))).toBe(true);
    expect(g.feeRecipients.map((k) => k.toBase58())).toEqual([key(2).toBase58(), key(3).toBase58()]);
    expect(g.buybackFeeRecipients.map((k) => k.toBase58())).toEqual([key(4).toBase58()]);
    expect(g.feeBasisPoints).toBe(95n);
    expect(g.creatorFeeBasisPoints).toBe(30n);
  });
});

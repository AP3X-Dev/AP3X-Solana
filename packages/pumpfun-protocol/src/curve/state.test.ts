import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { AccountLayoutError, decodeCurveState, deriveBondingCurvePda } from './state.js';

const MINT_BASE58 = 'So11111111111111111111111111111111111111112';

/** Deterministic creator pubkey for synthetic fixtures. */
const SYNTHETIC_CREATOR_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

/** Arbitrary Anchor-style discriminator — first 8 bytes of SHA-256("account:BondingCurve") in principle.
 *  For the decoder these are skipped, so any 8-byte prefix works for unit coverage. */
const SYNTHETIC_DISCRIMINATOR = new Uint8Array([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);

/**
 * Build a synthetic bonding-curve account payload matching the decoder's
 * read order exactly:
 *
 *   8  bytes  discriminator   (any 8 bytes; decoder skips them)
 *   8  bytes  virtualTokenReserves  u64 LE
 *   8  bytes  virtualSolReserves    u64 LE
 *   8  bytes  realTokenReserves     u64 LE
 *   8  bytes  realSolReserves       u64 LE
 *   8  bytes  tokenTotalSupply      u64 LE
 *   1  byte   complete              bool
 *   32 bytes  creator               pubkey
 *   8  bytes  createdAt             i64 LE (unix seconds)
 *
 *   Total: 89 bytes.
 */
function buildSyntheticCurveStateAccount(fields: {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator?: Uint8Array;
  createdAt?: bigint;
}): Uint8Array {
  const buf = new Uint8Array(89);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf.set(SYNTHETIC_DISCRIMINATOR, 0);

  view.setBigUint64(8, fields.virtualTokenReserves, true);
  view.setBigUint64(16, fields.virtualSolReserves, true);
  view.setBigUint64(24, fields.realTokenReserves, true);
  view.setBigUint64(32, fields.realSolReserves, true);
  view.setBigUint64(40, fields.tokenTotalSupply, true);

  buf[48] = fields.complete ? 1 : 0;

  const creator = fields.creator ?? SYNTHETIC_CREATOR_BYTES;
  buf.set(creator, 49);

  const createdAt = fields.createdAt ?? 1_700_000_000n;
  view.setBigInt64(81, createdAt, true);

  return buf;
}

describe('deriveBondingCurvePda', () => {
  it('derives a deterministic address from the mint', () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const { address, bump } = deriveBondingCurvePda(mint);
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThan(256);
  });

  it('is stable across calls', () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const a = deriveBondingCurvePda(mint);
    const b = deriveBondingCurvePda(mint);
    expect(a.address.equals(b.address)).toBe(true);
    expect(a.bump).toBe(b.bump);
  });

  it('produces different PDAs for different mints', () => {
    const mintA = PublicKey.fromBase58(MINT_BASE58);
    const mintB = PublicKey.fromBase58('11111111111111111111111111111111');
    const a = deriveBondingCurvePda(mintA);
    const b = deriveBondingCurvePda(mintB);
    expect(a.address.equals(b.address)).toBe(false);
  });
});

describe('decodeCurveState', () => {
  it('returns a typed CurveState from valid account bytes', () => {
    const bytes = buildSyntheticCurveStateAccount({
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realSolReserves: 1_000_000_000n,
      realTokenReserves: 500_000_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
    });
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const state = decodeCurveState(bytes, mint);

    expect(state.mint.equals(mint)).toBe(true);
    expect(state.virtualSolReserves).toBe(30_000_000_000n);
    expect(state.virtualTokenReserves).toBe(1_073_000_000_000_000n);
    expect(state.realSolReserves).toBe(1_000_000_000n);
    expect(state.realTokenReserves).toBe(500_000_000_000_000n);
    expect(state.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(state.complete).toBe(false);
    expect(state.creator).toBeInstanceOf(PublicKey);
    expect(Array.from(state.creator.toBuffer())).toEqual(Array.from(SYNTHETIC_CREATOR_BYTES));
    expect(state.createdAt).toBe(1_700_000_000);
    expect(state.bondingCurve.equals(deriveBondingCurvePda(mint).address)).toBe(true);
  });

  it('decodes the `complete` flag as true when set', () => {
    const bytes = buildSyntheticCurveStateAccount({
      virtualSolReserves: 0n,
      virtualTokenReserves: 0n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 0n,
      complete: true,
    });
    const state = decodeCurveState(bytes, PublicKey.fromBase58(MINT_BASE58));
    expect(state.complete).toBe(true);
  });

  it('throws AccountLayoutError on size mismatch (too-small buffer)', () => {
    expect(() =>
      decodeCurveState(new Uint8Array(10), PublicKey.fromBase58(MINT_BASE58)),
    ).toThrow(AccountLayoutError);
    expect(() =>
      decodeCurveState(new Uint8Array(10), PublicKey.fromBase58(MINT_BASE58)),
    ).toThrow(/bonding-curve/);
  });

  it('AccountLayoutError carries expected + observed + field', () => {
    const tiny = new Uint8Array(10);
    try {
      decodeCurveState(tiny, PublicKey.fromBase58(MINT_BASE58));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountLayoutError);
      const e = err as AccountLayoutError;
      expect(e.expected).toBe('bonding-curve');
      expect(e.observed).toBe(tiny);
      // The size-mismatch path does not set `field` — only the Borsh catch does.
      expect(e.field).toBeUndefined();
    }
  });
});

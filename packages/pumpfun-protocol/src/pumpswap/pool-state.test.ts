import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { AccountLayoutError } from '../curve/state.js';
import { decodePumpSwapPoolState, derivePumpSwapPoolPda } from './pool-state.js';

const MINT_BASE58 = 'So11111111111111111111111111111111111111112';

/** Deterministic pubkey bytes for synthetic fixtures. */
const BASE_MINT_BYTES = new Uint8Array(32).map((_, i) => (i * 3 + 1) & 0xff);
const QUOTE_MINT_BYTES = new Uint8Array(32).map((_, i) => (i * 5 + 2) & 0xff);
const LP_MINT_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const FREEZE_AUTH_BYTES = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
const UPDATE_AUTH_BYTES = new Uint8Array(32).map((_, i) => (i * 13 + 7) & 0xff);

/** Arbitrary Anchor-style discriminator — the decoder skips these 8 bytes. */
const SYNTHETIC_DISCRIMINATOR = new Uint8Array([0x2a, 0x41, 0x9f, 0xc0, 0x11, 0x33, 0x77, 0x88]);

/**
 * Build a synthetic PumpSwap pool account payload matching the decoder's
 * read order exactly:
 *
 *   8  bytes  discriminator   (any 8 bytes; decoder skips them)
 *   32 bytes  baseMint        Pubkey
 *   32 bytes  quoteMint       Pubkey
 *   8  bytes  baseReserves    u64 LE
 *   8  bytes  quoteReserves   u64 LE
 *   32 bytes  lpMint          Pubkey
 *   2  bytes  feeBasisPoints  u16 LE
 *   1  byte   freeze Option tag (0 = None, 1 = Some)
 *   [32 bytes freeze pubkey, if Some]
 *   1  byte   update Option tag (0 = None, 1 = Some)
 *   [32 bytes update pubkey, if Some]
 *
 *   Minimum total (both None): 124 bytes.
 */
function buildSyntheticPoolStateAccount(fields: {
  baseReserves: bigint;
  quoteReserves: bigint;
  feeBasisPoints: number;
  baseMint?: Uint8Array;
  quoteMint?: Uint8Array;
  lpMint?: Uint8Array;
  freezeAuthority?: Uint8Array;
  updateAuthority?: Uint8Array;
}): Uint8Array {
  const baseMint = fields.baseMint ?? BASE_MINT_BYTES;
  const quoteMint = fields.quoteMint ?? QUOTE_MINT_BYTES;
  const lpMint = fields.lpMint ?? LP_MINT_BYTES;

  const freezeSize = fields.freezeAuthority ? 33 : 1;
  const updateSize = fields.updateAuthority ? 33 : 1;
  const totalSize = 8 + 32 + 32 + 8 + 8 + 32 + 2 + freezeSize + updateSize;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf.set(SYNTHETIC_DISCRIMINATOR, 0);
  buf.set(baseMint, 8);
  buf.set(quoteMint, 40);
  view.setBigUint64(72, fields.baseReserves, true);
  view.setBigUint64(80, fields.quoteReserves, true);
  buf.set(lpMint, 88);
  view.setUint16(120, fields.feeBasisPoints, true);

  let offset = 122;
  if (fields.freezeAuthority) {
    buf[offset] = 1;
    buf.set(fields.freezeAuthority, offset + 1);
    offset += 33;
  } else {
    buf[offset] = 0;
    offset += 1;
  }

  if (fields.updateAuthority) {
    buf[offset] = 1;
    buf.set(fields.updateAuthority, offset + 1);
  } else {
    buf[offset] = 0;
  }

  return buf;
}

describe('derivePumpSwapPoolPda', () => {
  it('derives a deterministic address from the mint', () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const { address, bump } = derivePumpSwapPoolPda(mint);
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThan(256);
  });

  it('is stable across calls', () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const a = derivePumpSwapPoolPda(mint);
    const b = derivePumpSwapPoolPda(mint);
    expect(a.address.equals(b.address)).toBe(true);
    expect(a.bump).toBe(b.bump);
  });

  it('produces different PDAs for different mints', () => {
    const mintA = PublicKey.fromBase58(MINT_BASE58);
    const mintB = PublicKey.fromBase58('11111111111111111111111111111111');
    const a = derivePumpSwapPoolPda(mintA);
    const b = derivePumpSwapPoolPda(mintB);
    expect(a.address.equals(b.address)).toBe(false);
  });
});

describe('decodePumpSwapPoolState', () => {
  it('returns a typed PumpSwapPoolState from valid account bytes (no authorities)', () => {
    const bytes = buildSyntheticPoolStateAccount({
      baseReserves: 5_000_000_000_000n,
      quoteReserves: 200_000_000_000n,
      feeBasisPoints: 30,
    });
    const poolAddr = PublicKey.fromBase58(MINT_BASE58);
    const state = decodePumpSwapPoolState(bytes, poolAddr);

    expect(state.pool.equals(poolAddr)).toBe(true);
    expect(Array.from(state.baseMint.toBuffer())).toEqual(Array.from(BASE_MINT_BYTES));
    expect(Array.from(state.quoteMint.toBuffer())).toEqual(Array.from(QUOTE_MINT_BYTES));
    expect(state.baseReserves).toBe(5_000_000_000_000n);
    expect(state.quoteReserves).toBe(200_000_000_000n);
    expect(Array.from(state.lpMint.toBuffer())).toEqual(Array.from(LP_MINT_BYTES));
    expect(state.feeBasisPoints).toBe(30);
    expect(state.authorities.freeze).toBeUndefined();
    expect(state.authorities.update).toBeUndefined();
  });

  it('decodes both Option<Pubkey> authorities when Some', () => {
    const bytes = buildSyntheticPoolStateAccount({
      baseReserves: 1n,
      quoteReserves: 1n,
      feeBasisPoints: 25,
      freezeAuthority: FREEZE_AUTH_BYTES,
      updateAuthority: UPDATE_AUTH_BYTES,
    });
    const state = decodePumpSwapPoolState(bytes, PublicKey.fromBase58(MINT_BASE58));

    expect(state.authorities.freeze).toBeInstanceOf(PublicKey);
    expect(state.authorities.update).toBeInstanceOf(PublicKey);
    expect(Array.from(state.authorities.freeze!.toBuffer())).toEqual(
      Array.from(FREEZE_AUTH_BYTES),
    );
    expect(Array.from(state.authorities.update!.toBuffer())).toEqual(
      Array.from(UPDATE_AUTH_BYTES),
    );
  });

  it('decodes mixed authorities (freeze Some, update None)', () => {
    const bytes = buildSyntheticPoolStateAccount({
      baseReserves: 0n,
      quoteReserves: 0n,
      feeBasisPoints: 0,
      freezeAuthority: FREEZE_AUTH_BYTES,
    });
    const state = decodePumpSwapPoolState(bytes, PublicKey.fromBase58(MINT_BASE58));
    expect(state.authorities.freeze).toBeInstanceOf(PublicKey);
    expect(state.authorities.update).toBeUndefined();
  });

  it('throws AccountLayoutError on size mismatch (too-small buffer)', () => {
    expect(() =>
      decodePumpSwapPoolState(new Uint8Array(10), PublicKey.fromBase58(MINT_BASE58)),
    ).toThrow(AccountLayoutError);
    expect(() =>
      decodePumpSwapPoolState(new Uint8Array(10), PublicKey.fromBase58(MINT_BASE58)),
    ).toThrow(/pumpswap-pool/);
  });

  it('AccountLayoutError carries expected + observed + field', () => {
    const tiny = new Uint8Array(10);
    try {
      decodePumpSwapPoolState(tiny, PublicKey.fromBase58(MINT_BASE58));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountLayoutError);
      const e = err as AccountLayoutError;
      expect(e.expected).toBe('pumpswap-pool');
      expect(e.observed).toBe(tiny);
      // The size-mismatch path does not set `field` — only the Borsh catch does.
      expect(e.field).toBeUndefined();
    }
  });
});

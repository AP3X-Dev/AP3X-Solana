import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';

import { creator } from './creator.js';
import { deriveBondingCurvePda } from './curve/state.js';

const MINT_BASE58 = 'So11111111111111111111111111111111111111112';

/**
 * Deterministic creator bytes — same derivation pattern as the curve/state
 * test fixtures so a human diffing the two files can spot the reuse.
 */
const SYNTHETIC_CREATOR_BYTES = new Uint8Array(32).map(
  (_, i) => (i * 7 + 3) & 0xff,
);

const SYNTHETIC_DISCRIMINATOR = new Uint8Array([
  0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60,
]);

/**
 * Build a synthetic bonding-curve account. The `creator` field lives at
 * offset 49 (post 8-byte discriminator + 40-byte reserves + 1-byte complete).
 * Kept independent from the copy in `curve/state.test.ts` so this test's
 * failure message is local — a breakage here means the creator helper drifted
 * from the curve fetch, not that the underlying layout moved.
 */
function buildSyntheticCurveAccount(creatorBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(89);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf.set(SYNTHETIC_DISCRIMINATOR, 0);
  // reserves + totalSupply: 5 x u64 LE all zero (fine for this test)
  view.setBigUint64(8, 0n, true);
  view.setBigUint64(16, 0n, true);
  view.setBigUint64(24, 0n, true);
  view.setBigUint64(32, 0n, true);
  view.setBigUint64(40, 0n, true);
  buf[48] = 0; // complete = false
  buf.set(creatorBytes, 49);
  view.setBigInt64(81, 1_700_000_000n, true);
  return buf;
}

describe('creator', () => {
  it('delegates to curveState and returns its .creator field', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const { address: curvePda } = deriveBondingCurvePda(mint);

    const accountBytes = buildSyntheticCurveAccount(SYNTHETIC_CREATOR_BYTES);
    const base64Data = Buffer.from(accountBytes).toString('base64');

    const call = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe('getAccountInfo');
      // Parameters form: [pubkey, { encoding: 'base64' }]
      const asArr = params as unknown[];
      expect(asArr[0]).toBe(curvePda.toBase58());
      return { value: { data: [base64Data, 'base64'] } };
    });

    const pool = { call } as unknown as Parameters<typeof creator>[0];
    const result = await creator(pool, mint);

    expect(result).toBeInstanceOf(PublicKey);
    expect(Array.from(result.toBuffer())).toEqual(
      Array.from(SYNTHETIC_CREATOR_BYTES),
    );
    // Exactly one round-trip — no duplicate PDA fetching logic.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('propagates the underlying AccountLayoutError when the curve is missing', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const call = vi.fn(async () => ({ value: null }));
    const pool = { call } as unknown as Parameters<typeof creator>[0];

    await expect(creator(pool, mint)).rejects.toThrow(/bonding-curve/);
  });
});

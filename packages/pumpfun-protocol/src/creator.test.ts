import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';

import { creator } from './creator.js';
import { deriveBondingCurvePda } from './curve/state.js';
import { bondingCurveBytes } from './_test-accounts.js';

const MINT_BASE58 = 'So11111111111111111111111111111111111111112';

const SYNTHETIC_CREATOR_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

describe('creator', () => {
  it('delegates to curveState and returns its .creator field', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const { address: curvePda } = deriveBondingCurvePda(mint);

    const accountBytes = bondingCurveBytes({ creator: PublicKey.fromBytes(SYNTHETIC_CREATOR_BYTES) });
    const base64Data = Buffer.from(accountBytes).toString('base64');

    const call = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe('getAccountInfo');
      // Parameters form: [pubkey, { encoding: 'base64', commitment: 'confirmed' }] (the default, finalized, is ~13 s stale)
      const asArr = params as unknown[];
      expect(asArr[0]).toBe(curvePda.toBase58());
      expect(asArr[1]).toEqual({ encoding: 'base64', commitment: 'confirmed' });
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

    await expect(creator(pool, mint)).rejects.toThrow(/BondingCurve.*account not found/);
  });
});

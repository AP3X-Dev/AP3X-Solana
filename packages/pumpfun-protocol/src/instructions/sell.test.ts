/**
 * Shape-only unit tests for {@link buildSell}.
 *
 * Mirror of `buy.test.ts`. These tests verify the static contract — return
 * type, validation errors, discriminator bytes, u64 LE encoding — without
 * touching the network. Not authoritative for the semantic correctness of
 * the account layout; see `sell.ts` for the best-effort assumption block.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { buildSell } from './sell.js';

const MINT = PublicKey.fromBase58('So11111111111111111111111111111111111111112');
const USER = PublicKey.fromBase58('11111111111111111111111111111112');
const USER_TOKEN_ACCOUNT = PublicKey.fromBase58(
  '11111111111111111111111111111113',
);

describe('buildSell — shape', () => {
  it('returns an Instruction targeting the bonding-curve program', () => {
    const ix = buildSell({
      mint: MINT,
      user: USER,
      tokenAmount: 1_000_000_000n,
      minSolOut: 50_000n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });
    expect(ix.programId.equals(PUMPFUN_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    expect(Array.isArray(ix.keys)).toBe(true);
    expect(ix.data.length).toBe(24); // 8 disc + 2 * u64
  });

  it('builds a 12-account list in the documented order', () => {
    const ix = buildSell({
      mint: MINT,
      user: USER,
      tokenAmount: 1n,
      minSolOut: 0n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });
    expect(ix.keys.length).toBe(12);

    const mintMeta = ix.keys[2];
    const userTokenMeta = ix.keys[5];
    const userMeta = ix.keys[6];
    const programMeta = ix.keys[11];
    if (!mintMeta || !userTokenMeta || !userMeta || !programMeta) {
      throw new Error('expected fully populated key list');
    }
    expect(mintMeta.pubkey.equals(MINT)).toBe(true);
    expect(userTokenMeta.pubkey.equals(USER_TOKEN_ACCOUNT)).toBe(true);
    expect(userMeta.pubkey.equals(USER)).toBe(true);
    expect(programMeta.pubkey.equals(PUMPFUN_BONDING_CURVE_PROGRAM_ID)).toBe(
      true,
    );
  });

  it('marks only the user as signer, and the right accounts as writable', () => {
    const ix = buildSell({
      mint: MINT,
      user: USER,
      tokenAmount: 1n,
      minSolOut: 0n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });
    for (let i = 0; i < ix.keys.length; i++) {
      const meta = ix.keys[i];
      if (!meta) throw new Error(`missing key at index ${i}`);
      expect(meta.isSigner).toBe(i === 6);
    }
    // Writable set mirrors buildBuy (same layout, same direction of mutation):
    // fee recipient (1), bonding curve (3), associated bonding curve (4),
    // user token account (5), user (6).
    const writable = new Set([1, 3, 4, 5, 6]);
    for (let i = 0; i < ix.keys.length; i++) {
      const meta = ix.keys[i];
      if (!meta) throw new Error(`missing key at index ${i}`);
      expect(meta.isWritable).toBe(writable.has(i));
    }
  });

  it('encodes discriminator + tokenAmount + minSolOut as u64 LE', () => {
    const tokenAmount = 0x0102030405060708n;
    const minSolOut = 0x0a0b0c0d0e0f1011n;
    const ix = buildSell({
      mint: MINT,
      user: USER,
      tokenAmount,
      minSolOut,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });

    // Discriminator: first 8 bytes = sha256("global:sell")[..8] = `33e685a4017f83ad`
    expect(Array.from(ix.data.slice(0, 8))).toEqual([
      0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad,
    ]);
    // tokenAmount — u64 LE of 0x0102030405060708 → [08 07 06 05 04 03 02 01]
    expect(Array.from(ix.data.slice(8, 16))).toEqual([
      0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    ]);
    // minSolOut — u64 LE of 0x0a0b0c0d0e0f1011 → [11 10 0f 0e 0d 0c 0b 0a]
    expect(Array.from(ix.data.slice(16, 24))).toEqual([
      0x11, 0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a,
    ]);
  });

  it('rejects zero tokenAmount', () => {
    expect(() =>
      buildSell({
        mint: MINT,
        user: USER,
        tokenAmount: 0n,
        minSolOut: 0n,
        userTokenAccount: USER_TOKEN_ACCOUNT,
      }),
    ).toThrow(TypeError);
  });

  it('rejects negative tokenAmount', () => {
    expect(() =>
      buildSell({
        mint: MINT,
        user: USER,
        tokenAmount: -1n,
        minSolOut: 0n,
        userTokenAccount: USER_TOKEN_ACCOUNT,
      }),
    ).toThrow(TypeError);
  });

  it('rejects negative minSolOut', () => {
    expect(() =>
      buildSell({
        mint: MINT,
        user: USER,
        tokenAmount: 1n,
        minSolOut: -1n,
        userTokenAccount: USER_TOKEN_ACCOUNT,
      }),
    ).toThrow(TypeError);
  });

  it('accepts minSolOut of zero (market-sell-any-price)', () => {
    // Liquidation strategies legitimately set a zero floor. Program still
    // enforces its own rails; the builder doesn't second-guess intent.
    const ix = buildSell({
      mint: MINT,
      user: USER,
      tokenAmount: 1_000_000n,
      minSolOut: 0n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });
    expect(ix.data.length).toBe(24);
  });

  it('derives the same instruction for the same params (deterministic)', () => {
    const params = {
      mint: MINT,
      user: USER,
      tokenAmount: 987_654_321n,
      minSolOut: 1_234_567n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    };
    const a = buildSell(params);
    const b = buildSell(params);
    expect(a.keys.length).toBe(b.keys.length);
    for (let i = 0; i < a.keys.length; i++) {
      const ka = a.keys[i];
      const kb = b.keys[i];
      if (!ka || !kb) throw new Error(`missing key at index ${i}`);
      expect(ka.pubkey.equals(kb.pubkey)).toBe(true);
      expect(ka.isSigner).toBe(kb.isSigner);
      expect(ka.isWritable).toBe(kb.isWritable);
    }
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

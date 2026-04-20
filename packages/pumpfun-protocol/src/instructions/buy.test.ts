/**
 * Shape-only unit tests for {@link buildBuy}.
 *
 * These tests verify the static contract — return type, validation errors,
 * discriminator bytes, u64 LE encoding — without touching the network. They
 * are not authoritative for the *semantic* correctness of the account layout.
 * See the file-top comment in `buy.ts` for the best-effort assumptions that
 * need mainnet confirmation once a Helius API key is available.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { buildBuy } from './buy.js';

const MINT = PublicKey.fromBase58('So11111111111111111111111111111111111111112');
// Distinct fake user/token-account pubkeys. `11...11` is the System Program
// and doesn't make a sensible signer or ATA; using distinct all-ones keys
// keeps the test data obviously synthetic but valid.
const USER = PublicKey.fromBase58('11111111111111111111111111111112');
const USER_TOKEN_ACCOUNT = PublicKey.fromBase58(
  '11111111111111111111111111111113',
);

describe('buildBuy — shape', () => {
  it('returns an Instruction targeting the bonding-curve program', () => {
    const ix = buildBuy({
      mint: MINT,
      user: USER,
      solIn: 1_000_000n,
      maxSolCost: 1_100_000n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });
    expect(ix.programId.equals(PUMPFUN_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    expect(Array.isArray(ix.keys)).toBe(true);
    // 8-byte discriminator + two u64 arguments = 24 bytes exactly.
    expect(ix.data.length).toBe(24);
  });

  it('builds a 12-account list in the documented order', () => {
    const ix = buildBuy({
      mint: MINT,
      user: USER,
      solIn: 1n,
      maxSolCost: 1n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });
    expect(ix.keys.length).toBe(12);

    // The four caller-supplied pubkeys live at their documented positions.
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
    const ix = buildBuy({
      mint: MINT,
      user: USER,
      solIn: 1n,
      maxSolCost: 1n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });
    // Exactly one signer — the user at index 6.
    for (let i = 0; i < ix.keys.length; i++) {
      const meta = ix.keys[i];
      if (!meta) throw new Error(`missing key at index ${i}`);
      expect(meta.isSigner).toBe(i === 6);
    }
    // Writable set: fee recipient (1), bonding curve (3), associated
    // bonding curve (4), user token account (5), user (6).
    const writable = new Set([1, 3, 4, 5, 6]);
    for (let i = 0; i < ix.keys.length; i++) {
      const meta = ix.keys[i];
      if (!meta) throw new Error(`missing key at index ${i}`);
      expect(meta.isWritable).toBe(writable.has(i));
    }
  });

  it('encodes discriminator + solIn + maxSolCost as u64 LE', () => {
    const solIn = 0x0102030405060708n; // distinctive byte pattern
    const maxSolCost = 0x0a0b0c0d0e0f1011n;
    const ix = buildBuy({
      mint: MINT,
      user: USER,
      solIn,
      maxSolCost,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });

    // Discriminator: first 8 bytes = sha256("global:buy")[..8] = `66063d1201daebea`
    expect(Array.from(ix.data.slice(0, 8))).toEqual([
      0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea,
    ]);
    // solIn — u64 LE of 0x0102030405060708 → [08 07 06 05 04 03 02 01]
    expect(Array.from(ix.data.slice(8, 16))).toEqual([
      0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    ]);
    // maxSolCost — u64 LE of 0x0a0b0c0d0e0f1011 → [11 10 0f 0e 0d 0c 0b 0a]
    expect(Array.from(ix.data.slice(16, 24))).toEqual([
      0x11, 0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a,
    ]);
  });

  it('rejects zero solIn', () => {
    expect(() =>
      buildBuy({
        mint: MINT,
        user: USER,
        solIn: 0n,
        maxSolCost: 1n,
        userTokenAccount: USER_TOKEN_ACCOUNT,
      }),
    ).toThrow(TypeError);
  });

  it('rejects negative solIn', () => {
    expect(() =>
      buildBuy({
        mint: MINT,
        user: USER,
        solIn: -1n,
        maxSolCost: 1n,
        userTokenAccount: USER_TOKEN_ACCOUNT,
      }),
    ).toThrow(TypeError);
  });

  it('rejects maxSolCost below solIn (inverted slippage)', () => {
    expect(() =>
      buildBuy({
        mint: MINT,
        user: USER,
        solIn: 1_000_000n,
        maxSolCost: 900_000n,
        userTokenAccount: USER_TOKEN_ACCOUNT,
      }),
    ).toThrow(TypeError);
  });

  it('accepts maxSolCost exactly equal to solIn (zero-slippage edge)', () => {
    // The program rejects the fill if price moved, but the *builder* has no
    // reason to reject this shape — a caller may deliberately demand exact
    // execution at the pre-trade quote.
    const ix = buildBuy({
      mint: MINT,
      user: USER,
      solIn: 1_000_000n,
      maxSolCost: 1_000_000n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    });
    expect(ix.data.length).toBe(24);
  });

  it('derives the same instruction for the same params (deterministic)', () => {
    const params = {
      mint: MINT,
      user: USER,
      solIn: 123_456_789n,
      maxSolCost: 234_567_890n,
      userTokenAccount: USER_TOKEN_ACCOUNT,
    };
    const a = buildBuy(params);
    const b = buildBuy(params);
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

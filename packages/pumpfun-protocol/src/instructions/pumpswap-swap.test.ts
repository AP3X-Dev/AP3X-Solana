/**
 * Shape-only unit tests for {@link buildPumpSwapSwap}.
 *
 * Mirrors `buy.test.ts` / `sell.test.ts`. Verifies the static contract —
 * return type, validation errors, discriminator bytes, u64 LE encoding —
 * without touching the network. See `pumpswap-swap.ts` for the best-effort
 * assumption block covering account layout and discriminator.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { PUMPFUN_PUMPSWAP_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { buildPumpSwapSwap } from './pumpswap-swap.js';

// Distinct synthetic pubkeys — using all-ones variations keeps the test data
// obviously fake but valid for the ed25519 format checks.
const POOL = PublicKey.fromBase58('11111111111111111111111111111112');
const USER = PublicKey.fromBase58('11111111111111111111111111111113');
const WSOL = PublicKey.fromBase58('So11111111111111111111111111111111111111112');
const PUMP_MINT = PublicKey.fromBase58(
  '11111111111111111111111111111114',
);
const USER_INPUT = PublicKey.fromBase58(
  '11111111111111111111111111111115',
);
const USER_OUTPUT = PublicKey.fromBase58(
  '11111111111111111111111111111116',
);

describe('buildPumpSwapSwap — shape', () => {
  it('returns an Instruction targeting the PumpSwap program', () => {
    const ix = buildPumpSwapSwap({
      pool: POOL,
      user: USER,
      inputMint: WSOL,
      outputMint: PUMP_MINT,
      inputAmount: 1_000_000n,
      minOutputAmount: 100n,
      userInputAccount: USER_INPUT,
      userOutputAccount: USER_OUTPUT,
    });
    expect(ix.programId.equals(PUMPFUN_PUMPSWAP_PROGRAM_ID)).toBe(true);
    expect(Array.isArray(ix.keys)).toBe(true);
    expect(ix.data.length).toBe(24); // 8 disc + 2 * u64
  });

  it('builds a 13-account list with caller-supplied pubkeys at documented positions', () => {
    const ix = buildPumpSwapSwap({
      pool: POOL,
      user: USER,
      inputMint: WSOL,
      outputMint: PUMP_MINT,
      inputAmount: 1n,
      minOutputAmount: 0n,
      userInputAccount: USER_INPUT,
      userOutputAccount: USER_OUTPUT,
    });
    expect(ix.keys.length).toBe(13);

    // The six caller-supplied pubkeys live at their documented positions.
    const poolMeta = ix.keys[0];
    const userMeta = ix.keys[1];
    const inputMintMeta = ix.keys[2];
    const outputMintMeta = ix.keys[3];
    const userInputMeta = ix.keys[4];
    const userOutputMeta = ix.keys[5];
    const programMeta = ix.keys[12];
    if (
      !poolMeta ||
      !userMeta ||
      !inputMintMeta ||
      !outputMintMeta ||
      !userInputMeta ||
      !userOutputMeta ||
      !programMeta
    ) {
      throw new Error('expected fully populated key list');
    }
    expect(poolMeta.pubkey.equals(POOL)).toBe(true);
    expect(userMeta.pubkey.equals(USER)).toBe(true);
    expect(inputMintMeta.pubkey.equals(WSOL)).toBe(true);
    expect(outputMintMeta.pubkey.equals(PUMP_MINT)).toBe(true);
    expect(userInputMeta.pubkey.equals(USER_INPUT)).toBe(true);
    expect(userOutputMeta.pubkey.equals(USER_OUTPUT)).toBe(true);
    expect(programMeta.pubkey.equals(PUMPFUN_PUMPSWAP_PROGRAM_ID)).toBe(true);
  });

  it('marks only the user as signer, and the right accounts as writable', () => {
    const ix = buildPumpSwapSwap({
      pool: POOL,
      user: USER,
      inputMint: WSOL,
      outputMint: PUMP_MINT,
      inputAmount: 1n,
      minOutputAmount: 0n,
      userInputAccount: USER_INPUT,
      userOutputAccount: USER_OUTPUT,
    });
    // Exactly one signer — the user at index 1.
    for (let i = 0; i < ix.keys.length; i++) {
      const meta = ix.keys[i];
      if (!meta) throw new Error(`missing key at index ${i}`);
      expect(meta.isSigner).toBe(i === 1);
    }
    // Writable set: pool (0), user (1), userInput (4), userOutput (5),
    // pool base vault (6), pool quote vault (7). Mints and program refs
    // are readonly.
    const writable = new Set([0, 1, 4, 5, 6, 7]);
    for (let i = 0; i < ix.keys.length; i++) {
      const meta = ix.keys[i];
      if (!meta) throw new Error(`missing key at index ${i}`);
      expect(meta.isWritable).toBe(writable.has(i));
    }
  });

  it('encodes discriminator + inputAmount + minOutputAmount as u64 LE', () => {
    const inputAmount = 0x0102030405060708n;
    const minOutputAmount = 0x0a0b0c0d0e0f1011n;
    const ix = buildPumpSwapSwap({
      pool: POOL,
      user: USER,
      inputMint: WSOL,
      outputMint: PUMP_MINT,
      inputAmount,
      minOutputAmount,
      userInputAccount: USER_INPUT,
      userOutputAccount: USER_OUTPUT,
    });

    // Discriminator — ASSUMED `sha256("global:swap")[..8]` → `f8c69e91e17587c8`
    expect(Array.from(ix.data.slice(0, 8))).toEqual([
      0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8,
    ]);
    // inputAmount — u64 LE of 0x0102030405060708 → [08 07 06 05 04 03 02 01]
    expect(Array.from(ix.data.slice(8, 16))).toEqual([
      0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    ]);
    // minOutputAmount — u64 LE of 0x0a0b0c0d0e0f1011 → [11 10 0f 0e 0d 0c 0b 0a]
    expect(Array.from(ix.data.slice(16, 24))).toEqual([
      0x11, 0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a,
    ]);
  });

  it('rejects zero inputAmount', () => {
    expect(() =>
      buildPumpSwapSwap({
        pool: POOL,
        user: USER,
        inputMint: WSOL,
        outputMint: PUMP_MINT,
        inputAmount: 0n,
        minOutputAmount: 0n,
        userInputAccount: USER_INPUT,
        userOutputAccount: USER_OUTPUT,
      }),
    ).toThrow(TypeError);
  });

  it('rejects negative inputAmount', () => {
    expect(() =>
      buildPumpSwapSwap({
        pool: POOL,
        user: USER,
        inputMint: WSOL,
        outputMint: PUMP_MINT,
        inputAmount: -1n,
        minOutputAmount: 0n,
        userInputAccount: USER_INPUT,
        userOutputAccount: USER_OUTPUT,
      }),
    ).toThrow(TypeError);
  });

  it('rejects negative minOutputAmount', () => {
    expect(() =>
      buildPumpSwapSwap({
        pool: POOL,
        user: USER,
        inputMint: WSOL,
        outputMint: PUMP_MINT,
        inputAmount: 1n,
        minOutputAmount: -1n,
        userInputAccount: USER_INPUT,
        userOutputAccount: USER_OUTPUT,
      }),
    ).toThrow(TypeError);
  });

  it('rejects identical input/output mint', () => {
    expect(() =>
      buildPumpSwapSwap({
        pool: POOL,
        user: USER,
        inputMint: WSOL,
        outputMint: WSOL,
        inputAmount: 1n,
        minOutputAmount: 0n,
        userInputAccount: USER_INPUT,
        userOutputAccount: USER_OUTPUT,
      }),
    ).toThrow(TypeError);
  });

  it('accepts minOutputAmount of zero (market-swap-any-price)', () => {
    // Same rationale as the sell-side market order — callers can deliberately
    // disable the output floor when liquidating into a volatile book.
    const ix = buildPumpSwapSwap({
      pool: POOL,
      user: USER,
      inputMint: WSOL,
      outputMint: PUMP_MINT,
      inputAmount: 1_000_000n,
      minOutputAmount: 0n,
      userInputAccount: USER_INPUT,
      userOutputAccount: USER_OUTPUT,
    });
    expect(ix.data.length).toBe(24);
  });

  it('derives the same instruction for the same params (deterministic)', () => {
    const params = {
      pool: POOL,
      user: USER,
      inputMint: WSOL,
      outputMint: PUMP_MINT,
      inputAmount: 111_222_333n,
      minOutputAmount: 444_555_666n,
      userInputAccount: USER_INPUT,
      userOutputAccount: USER_OUTPUT,
    };
    const a = buildPumpSwapSwap(params);
    const b = buildPumpSwapSwap(params);
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

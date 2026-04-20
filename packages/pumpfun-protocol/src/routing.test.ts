/**
 * `routing.ts` unit tests.
 *
 * Exercises both branches of {@link buy} and {@link sell}:
 *
 *   - Pre-graduation: `CurveState.complete === false` → the helper must
 *     delegate to the bonding-curve builder (`buildBuy` / `buildSell`) and
 *     make exactly one RPC call (`getAccountInfo` for the curve account).
 *   - Post-graduation: `CurveState.complete === true` → the helper must
 *     delegate to the PumpSwap builder, make exactly two RPC calls (one for
 *     the curve, one for the pool), and compute slippage against the pool
 *     reserves using the shipped AMM math.
 *
 * We stub the `RpcPool` inline by matching on `(method, params[0])`: the
 * first `getAccountInfo` call is the bonding-curve PDA, the second is the
 * PumpSwap pool PDA. Account bytes are built synthetically to the same
 * layout the decoders consume (89 bytes for the curve, 124+ for the pool) —
 * identical to the helpers in `curve/state.test.ts` and
 * `pumpswap/pool-state.test.ts`, inlined here to keep the test self-contained
 * rather than re-exporting a test-only builder across module boundaries.
 */

import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';
import { deriveBondingCurvePda } from './curve/state.js';
import { derivePumpSwapPoolPda } from './pumpswap/pool-state.js';
import { ammTokensOut, ammSolOut } from './pumpswap/math.js';
import { buy, sell, WSOL_MINT } from './routing.js';

// A non-WSOL mint so the post-graduation swap branches (which pair `mint`
// against WSOL) don't trip the `inputMint !== outputMint` check in
// `buildPumpSwapSwap`. USDC is a convenient, well-known stand-in.
const MINT_BASE58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USER_BASE58 = '11111111111111111111111111111111';

/** Deterministic pubkey bytes for synthetic account payloads. */
const SYNTHETIC_CREATOR_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const BASE_MINT_BYTES = new Uint8Array(32).map((_, i) => (i * 3 + 1) & 0xff);
const QUOTE_MINT_BYTES = new Uint8Array(32).map((_, i) => (i * 5 + 2) & 0xff);
const LP_MINT_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

/**
 * Build a synthetic bonding-curve account payload — identical layout to
 * `curve/state.test.ts`'s helper. 89 bytes, discriminator skipped by the
 * decoder.
 */
function buildCurveStateBytes(fields: {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}): Uint8Array {
  const buf = new Uint8Array(89);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Any 8 bytes work for the discriminator — the decoder skips them.
  buf.set([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60], 0);
  view.setBigUint64(8, fields.virtualTokenReserves, true);
  view.setBigUint64(16, fields.virtualSolReserves, true);
  view.setBigUint64(24, fields.realTokenReserves, true);
  view.setBigUint64(32, fields.realSolReserves, true);
  view.setBigUint64(40, fields.tokenTotalSupply, true);
  buf[48] = fields.complete ? 1 : 0;
  buf.set(SYNTHETIC_CREATOR_BYTES, 49);
  view.setBigInt64(81, 1_700_000_000n, true);
  return buf;
}

/**
 * Build a synthetic PumpSwap pool account payload — identical layout to
 * `pumpswap/pool-state.test.ts`'s helper with both authorities absent.
 */
function buildPoolStateBytes(fields: {
  baseReserves: bigint;
  quoteReserves: bigint;
  feeBasisPoints: number;
}): Uint8Array {
  const buf = new Uint8Array(124);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf.set([0x2a, 0x41, 0x9f, 0xc0, 0x11, 0x33, 0x77, 0x88], 0);
  buf.set(BASE_MINT_BYTES, 8);
  buf.set(QUOTE_MINT_BYTES, 40);
  view.setBigUint64(72, fields.baseReserves, true);
  view.setBigUint64(80, fields.quoteReserves, true);
  buf.set(LP_MINT_BYTES, 88);
  view.setUint16(120, fields.feeBasisPoints, true);
  buf[122] = 0; // freeze Option<> = None
  buf[123] = 0; // update Option<> = None
  return buf;
}

/** Base64-encode a Uint8Array (Node Buffer shortcut, matches decoder path). */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Build a stub RpcPool whose `call` returns:
 *   - the caller-supplied `curveBytes` for the bonding-curve PDA
 *   - the caller-supplied `poolBytes` for the PumpSwap pool PDA (if present)
 *   - `{ value: null }` for anything else (so unrelated fetches fail cleanly)
 *
 * Returns `{ pool, call }` so individual tests can assert call counts and the
 * exact method/params sequence.
 */
function makeRpcPool(opts: {
  mint: PublicKey;
  curveBytes: Uint8Array;
  poolBytes?: Uint8Array;
}) {
  const curvePda = deriveBondingCurvePda(opts.mint).address.toBase58();
  const poolPda = derivePumpSwapPoolPda(opts.mint).address.toBase58();

  const call = vi.fn(async (method: string, params: unknown) => {
    expect(method).toBe('getAccountInfo');
    const arr = params as [string, { encoding: string }];
    expect(arr[1].encoding).toBe('base64');
    if (arr[0] === curvePda) {
      return { value: { data: [toBase64(opts.curveBytes), 'base64'] } };
    }
    if (opts.poolBytes && arr[0] === poolPda) {
      return { value: { data: [toBase64(opts.poolBytes), 'base64'] } };
    }
    return { value: null };
  });
  return { pool: { call } as unknown as RpcPool, call };
}

describe('buy', () => {
  it('pre-graduation: delegates to buildBuy on the bonding-curve program', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const user = PublicKey.fromBase58(USER_BASE58);
    const userTokenAccount = PublicKey.fromBase58(USER_BASE58);

    const curveBytes = buildCurveStateBytes({
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realSolReserves: 1_000_000_000n,
      realTokenReserves: 500_000_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
    });
    const { pool, call } = makeRpcPool({ mint, curveBytes });

    const ix = await buy(pool, mint, {
      user,
      solIn: 1_000_000n,
      maxSolCost: 2_000_000n,
      userTokenAccount,
    });

    // Bonding-curve program → routing picked buildBuy.
    expect(ix.programId.equals(PUMPFUN_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(12); // pump.fun Buy has 12 accounts.
    // Exactly one RPC call — no speculative pool fetch on the pre-grad path.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('post-graduation: delegates to buildPumpSwapSwap with WSOL as input', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const user = PublicKey.fromBase58(USER_BASE58);
    const userTokenAccount = PublicKey.fromBase58(USER_BASE58);
    const userInputAccount = PublicKey.fromBase58(USER_BASE58);
    const userOutputAccount = PublicKey.fromBase58(USER_BASE58);

    const curveBytes = buildCurveStateBytes({
      virtualSolReserves: 0n,
      virtualTokenReserves: 0n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: true,
    });
    const poolBytes = buildPoolStateBytes({
      baseReserves: 5_000_000_000_000n,
      quoteReserves: 200_000_000_000n,
      feeBasisPoints: 30,
    });
    const { pool, call } = makeRpcPool({ mint, curveBytes, poolBytes });

    const solIn = 1_000_000n;
    const ix = await buy(pool, mint, {
      user,
      solIn,
      maxSolCost: 2_000_000n,
      userTokenAccount,
      userInputAccount,
      userOutputAccount,
    });

    // PumpSwap program → routing picked buildPumpSwapSwap.
    expect(ix.programId.equals(PUMPFUN_PUMPSWAP_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(13); // PumpSwap Swap has 13 accounts.

    // Two RPC calls: curve state, then pool state — no extra round-trips.
    expect(call).toHaveBeenCalledTimes(2);

    // Slippage was computed against the pool reserves using the shipped
    // AMM math (`expectedTokensOut * 99 / 100`). Instruction data layout
    // (from buildPumpSwapSwap): 8 discriminator + 8 inputAmount + 8 minOut.
    const view = new DataView(
      ix.data.buffer,
      ix.data.byteOffset,
      ix.data.byteLength,
    );
    const inputAmount = view.getBigUint64(8, true);
    const minOutputAmount = view.getBigUint64(16, true);

    expect(inputAmount).toBe(solIn);

    const expected = ammTokensOut(
      solIn,
      { baseReserves: 5_000_000_000_000n, quoteReserves: 200_000_000_000n },
      30,
    );
    expect(minOutputAmount).toBe((expected * 99n) / 100n);

    // Input mint (position 2) is WSOL — confirming direction is SOL → token.
    expect(ix.keys[2]!.pubkey.equals(WSOL_MINT)).toBe(true);
    // Output mint (position 3) is the pump token.
    expect(ix.keys[3]!.pubkey.equals(mint)).toBe(true);
  });

  it('post-graduation without ATAs: throws a typed error', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const user = PublicKey.fromBase58(USER_BASE58);
    const userTokenAccount = PublicKey.fromBase58(USER_BASE58);

    const curveBytes = buildCurveStateBytes({
      virtualSolReserves: 0n,
      virtualTokenReserves: 0n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: true,
    });
    const { pool } = makeRpcPool({ mint, curveBytes });

    await expect(
      buy(pool, mint, {
        user,
        solIn: 1_000_000n,
        maxSolCost: 2_000_000n,
        userTokenAccount,
      }),
    ).rejects.toThrow(/post-graduation buys require userInputAccount/);
  });
});

describe('sell', () => {
  it('pre-graduation: delegates to buildSell on the bonding-curve program', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const user = PublicKey.fromBase58(USER_BASE58);
    const userTokenAccount = PublicKey.fromBase58(USER_BASE58);

    const curveBytes = buildCurveStateBytes({
      virtualSolReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realSolReserves: 1_000_000_000n,
      realTokenReserves: 500_000_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
    });
    const { pool, call } = makeRpcPool({ mint, curveBytes });

    const ix = await sell(pool, mint, {
      user,
      tokenAmount: 100_000_000n,
      minSolOut: 1_000n,
      userTokenAccount,
    });

    expect(ix.programId.equals(PUMPFUN_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(12);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('post-graduation: delegates to buildPumpSwapSwap with WSOL as output', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const user = PublicKey.fromBase58(USER_BASE58);
    const userTokenAccount = PublicKey.fromBase58(USER_BASE58);
    const userInputAccount = PublicKey.fromBase58(USER_BASE58);
    const userOutputAccount = PublicKey.fromBase58(USER_BASE58);

    const curveBytes = buildCurveStateBytes({
      virtualSolReserves: 0n,
      virtualTokenReserves: 0n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: true,
    });
    const poolBytes = buildPoolStateBytes({
      baseReserves: 5_000_000_000_000n,
      quoteReserves: 200_000_000_000n,
      feeBasisPoints: 30,
    });
    const { pool, call } = makeRpcPool({ mint, curveBytes, poolBytes });

    const tokenAmount = 100_000_000n;
    const ix = await sell(pool, mint, {
      user,
      tokenAmount,
      minSolOut: 0n, // caller-supplied floor is zero → computed floor wins.
      userTokenAccount,
      userInputAccount,
      userOutputAccount,
    });

    expect(ix.programId.equals(PUMPFUN_PUMPSWAP_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(13);
    // Two RPC calls total: curve + pool read exactly once, no double-reads.
    expect(call).toHaveBeenCalledTimes(2);

    const view = new DataView(
      ix.data.buffer,
      ix.data.byteOffset,
      ix.data.byteLength,
    );
    const inputAmount = view.getBigUint64(8, true);
    const minOutputAmount = view.getBigUint64(16, true);

    expect(inputAmount).toBe(tokenAmount);

    const expected = ammSolOut(
      tokenAmount,
      { baseReserves: 5_000_000_000_000n, quoteReserves: 200_000_000_000n },
      30,
    );
    expect(minOutputAmount).toBe((expected * 99n) / 100n);

    // Input mint (position 2) is the pump token — confirming token → SOL.
    expect(ix.keys[2]!.pubkey.equals(mint)).toBe(true);
    // Output mint (position 3) is WSOL.
    expect(ix.keys[3]!.pubkey.equals(WSOL_MINT)).toBe(true);
  });

  it('post-graduation: caller-supplied minSolOut wins when tighter than headroom', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const user = PublicKey.fromBase58(USER_BASE58);
    const userTokenAccount = PublicKey.fromBase58(USER_BASE58);
    const userInputAccount = PublicKey.fromBase58(USER_BASE58);
    const userOutputAccount = PublicKey.fromBase58(USER_BASE58);

    const curveBytes = buildCurveStateBytes({
      virtualSolReserves: 0n,
      virtualTokenReserves: 0n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: true,
    });
    const poolBytes = buildPoolStateBytes({
      baseReserves: 5_000_000_000_000n,
      quoteReserves: 200_000_000_000n,
      feeBasisPoints: 30,
    });
    const { pool } = makeRpcPool({ mint, curveBytes, poolBytes });

    const tokenAmount = 100_000_000n;
    const expected = ammSolOut(
      tokenAmount,
      { baseReserves: 5_000_000_000_000n, quoteReserves: 200_000_000_000n },
      30,
    );
    const headroom = (expected * 99n) / 100n;
    const tighterFloor = headroom + 1n;

    const ix = await sell(pool, mint, {
      user,
      tokenAmount,
      minSolOut: tighterFloor,
      userTokenAccount,
      userInputAccount,
      userOutputAccount,
    });

    const view = new DataView(
      ix.data.buffer,
      ix.data.byteOffset,
      ix.data.byteLength,
    );
    const minOutputAmount = view.getBigUint64(16, true);
    expect(minOutputAmount).toBe(tighterFloor);
  });

  it('post-graduation without ATAs: throws a typed error', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const user = PublicKey.fromBase58(USER_BASE58);
    const userTokenAccount = PublicKey.fromBase58(USER_BASE58);

    const curveBytes = buildCurveStateBytes({
      virtualSolReserves: 0n,
      virtualTokenReserves: 0n,
      realSolReserves: 0n,
      realTokenReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: true,
    });
    const { pool } = makeRpcPool({ mint, curveBytes });

    await expect(
      sell(pool, mint, {
        user,
        tokenAmount: 100_000_000n,
        minSolOut: 0n,
        userTokenAccount,
      }),
    ).rejects.toThrow(/post-graduation sells require userInputAccount/);
  });
});

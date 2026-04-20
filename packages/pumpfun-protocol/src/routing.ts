/**
 * Unified `buy` / `sell` routing across the pump.fun graduation boundary.
 *
 * Pump.fun tokens trade on two different programs in their lifecycle:
 *
 *   - **Pre-graduation** — liquidity lives on the bonding-curve program; the
 *     user calls `buildBuy` / `buildSell` on that program.
 *   - **Post-graduation** (`CurveState.complete === true`) — liquidity has
 *     migrated to a PumpSwap AMM pool; the user calls `buildPumpSwapSwap`
 *     with WSOL as one side and the pump token as the other.
 *
 * These routing helpers do one `curveState` RPC round-trip per invocation to
 * pick the correct builder, and on the post-graduation branch a second
 * `pumpSwapPoolState` round-trip to size slippage against the AMM reserves.
 * Strategies that trade the same mint in a tight loop should cache the state
 * and call the raw builders directly rather than routing per-trade.
 *
 * Return shape: a pure `Instruction` from `@ap3x/solana-tx`. No signing, no
 * assembly — callers hand the result to `assemble` alongside their signer
 * list, just like the raw builders.
 *
 * Slippage semantics:
 *
 *   - Pre-graduation: caller-supplied `maxSolCost` / `minSolOut` are passed
 *     through verbatim to the bonding-curve builders, which treat them as
 *     hard ceilings/floors the on-chain program enforces.
 *   - Post-graduation: we derive a floor on the out-side from the current
 *     pool reserves using the shipped AMM math (`ammTokensOut` / `ammSolOut`)
 *     and apply a 1% headroom (multiply by 99/100). For sells the caller's
 *     `minSolOut` acts as an additional floor — if it is tighter than the
 *     1%-headroom value the caller's wins. For buys the input-side ceiling
 *     is enforced implicitly by the fixed `inputAmount` (the user can never
 *     spend more than `solIn` on a PumpSwap swap).
 *
 * Post-graduation callers must additionally supply `userInputAccount` and
 * `userOutputAccount` (the caller's ATAs for the two swap sides). Pre-
 * graduation calls only use `userTokenAccount`. Keeping both sets optional
 * on the unified params record lets strategies build a single params object
 * even when they don't yet know which branch the routing will take.
 */

import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { Instruction } from '@ap3x/solana-tx';
import { buildBuy } from './instructions/buy.js';
import { buildSell } from './instructions/sell.js';
import { buildPumpSwapSwap } from './instructions/pumpswap-swap.js';
import { derivePumpSwapPoolPda } from './instructions/account-derivation.js';
import { curveState } from './curve/state.js';
import { pumpSwapPoolState } from './pumpswap/pool-state.js';
import { ammTokensOut, ammSolOut } from './pumpswap/math.js';

/**
 * Wrapped-SOL mint (`So11111111111111111111111111111111111111112`). On the
 * PumpSwap AMM the SOL side of a pump.fun pair is always wSOL; using this
 * constant for the input/output mint on post-graduation swaps keeps intent
 * unambiguous at the call site.
 */
export const WSOL_MINT = /* @__PURE__ */ PublicKey.fromBase58(
  'So11111111111111111111111111111111111111112',
);

/**
 * Parameters for the unified {@link buy} helper.
 *
 *   - `user` — wallet funding the buy and receiving tokens. Signer.
 *   - `solIn` — lamports to spend on the buy (pre-slippage notional).
 *   - `maxSolCost` — slippage ceiling for the pre-graduation path; the
 *     bonding curve rejects fills that exceed it. Unused on the post-
 *     graduation path (see file-top slippage semantics).
 *   - `userTokenAccount` — caller's ATA for `mint`. Required on the pre-
 *     graduation path.
 *   - `userInputAccount` / `userOutputAccount` — caller's ATAs for the two
 *     swap sides. Required on the post-graduation path (input = WSOL,
 *     output = `mint`) and otherwise unused.
 */
export interface UnifiedBuyParams {
  user: PublicKey;
  solIn: bigint;
  maxSolCost: bigint;
  userTokenAccount: PublicKey;
  userInputAccount?: PublicKey;
  userOutputAccount?: PublicKey;
}

/**
 * Parameters for the unified {@link sell} helper.
 *
 *   - `user` — wallet selling tokens and receiving SOL. Signer.
 *   - `tokenAmount` — token units to sell (base-unit precision).
 *   - `minSolOut` — slippage floor for the pre-graduation path. On the post-
 *     graduation path it acts as an additional floor on the computed 99%-
 *     headroom value; pass `0n` to use the computed floor alone.
 *   - `userTokenAccount` — caller's ATA for `mint`. Required on the pre-
 *     graduation path.
 *   - `userInputAccount` / `userOutputAccount` — caller's ATAs for the two
 *     swap sides. Required on the post-graduation path (input = `mint`,
 *     output = WSOL) and otherwise unused.
 */
export interface UnifiedSellParams {
  user: PublicKey;
  tokenAmount: bigint;
  minSolOut: bigint;
  userTokenAccount: PublicKey;
  userInputAccount?: PublicKey;
  userOutputAccount?: PublicKey;
}

/**
 * Dispatch a buy to the bonding-curve `buildBuy` or PumpSwap `buildPumpSwapSwap`
 * based on `CurveState.complete`.
 *
 * One `curveState` RPC call per invocation (plus one `pumpSwapPoolState` call
 * on the post-graduation branch). Callers doing repeated trades for the same
 * mint should cache the curve state and call the raw builders directly.
 *
 * @throws Error when the post-graduation branch is taken without
 *   `userInputAccount` / `userOutputAccount` — PumpSwap swaps require both.
 */
export async function buy(
  rpcPool: RpcPool,
  mint: PublicKey,
  params: UnifiedBuyParams,
): Promise<Instruction> {
  const state = await curveState(rpcPool, mint);
  if (!state.complete) {
    return buildBuy({
      mint,
      user: params.user,
      solIn: params.solIn,
      maxSolCost: params.maxSolCost,
      userTokenAccount: params.userTokenAccount,
    });
  }
  if (!params.userInputAccount || !params.userOutputAccount) {
    throw new Error(
      'post-graduation buys require userInputAccount + userOutputAccount for PumpSwap',
    );
  }
  const { address: pool } = derivePumpSwapPoolPda(mint);
  const poolInfo = await pumpSwapPoolState(rpcPool, pool);
  // Post-graduation buy: we send SOL (WSOL) in, receive the token out.
  const expectedTokensOut = ammTokensOut(
    params.solIn,
    { baseReserves: poolInfo.baseReserves, quoteReserves: poolInfo.quoteReserves },
    poolInfo.feeBasisPoints,
  );
  // 1% headroom: the on-chain fill must deliver at least 99% of the quote
  // computed off the freshly-read reserves or the program rejects the swap.
  const minOutputAmount = (expectedTokensOut * 99n) / 100n;
  return buildPumpSwapSwap({
    pool,
    user: params.user,
    inputMint: WSOL_MINT,
    outputMint: mint,
    inputAmount: params.solIn,
    minOutputAmount,
    userInputAccount: params.userInputAccount,
    userOutputAccount: params.userOutputAccount,
  });
}

/**
 * Dispatch a sell to the bonding-curve `buildSell` or PumpSwap
 * `buildPumpSwapSwap` based on `CurveState.complete`.
 *
 * Symmetric to {@link buy}: one `curveState` RPC call per invocation, plus
 * one `pumpSwapPoolState` call on the post-graduation branch. Pool state is
 * read exactly once on the post-graduation path (no redundant re-fetches for
 * the expected-out computation vs. the builder inputs).
 *
 * @throws Error when the post-graduation branch is taken without
 *   `userInputAccount` / `userOutputAccount`.
 */
export async function sell(
  rpcPool: RpcPool,
  mint: PublicKey,
  params: UnifiedSellParams,
): Promise<Instruction> {
  const state = await curveState(rpcPool, mint);
  if (!state.complete) {
    return buildSell({
      mint,
      user: params.user,
      tokenAmount: params.tokenAmount,
      minSolOut: params.minSolOut,
      userTokenAccount: params.userTokenAccount,
    });
  }
  if (!params.userInputAccount || !params.userOutputAccount) {
    throw new Error(
      'post-graduation sells require userInputAccount + userOutputAccount for PumpSwap',
    );
  }
  const { address: pool } = derivePumpSwapPoolPda(mint);
  const poolInfo = await pumpSwapPoolState(rpcPool, pool);
  const expectedSolOut = ammSolOut(
    params.tokenAmount,
    { baseReserves: poolInfo.baseReserves, quoteReserves: poolInfo.quoteReserves },
    poolInfo.feeBasisPoints,
  );
  // Floor minOutputAmount at the caller-supplied `minSolOut` when non-zero,
  // otherwise use 99% of the computed expected out as headroom. If the
  // caller's floor is tighter (higher) than the computed 99% value it wins —
  // we never loosen their slippage bound silently.
  const headroom = (expectedSolOut * 99n) / 100n;
  const minOutputAmount =
    params.minSolOut > 0n && params.minSolOut > headroom
      ? params.minSolOut
      : headroom;
  return buildPumpSwapSwap({
    pool,
    user: params.user,
    inputMint: mint,
    outputMint: WSOL_MINT,
    inputAmount: params.tokenAmount,
    minOutputAmount,
    userInputAccount: params.userInputAccount,
    userOutputAccount: params.userOutputAccount,
  });
}

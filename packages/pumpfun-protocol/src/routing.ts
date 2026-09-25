/**
 * Unified `buy` / `sell` routing across the pump.fun graduation boundary.
 *
 *   - **Pre-graduation** — liquidity lives on the bonding curve: `buy_exact_sol_in`
 *     / `sell` on the pump.fun program.
 *   - **Post-graduation** (`CurveState.complete`) — liquidity has migrated to the
 *     canonical PumpSwap pool: `buy_exact_quote_in` / `sell` on PumpSwap, with
 *     WSOL as the quote side.
 *
 * Each call reads the on-chain state the instruction needs (curve + `Global`,
 * or pool + `GlobalConfig` + reserves). Strategies trading one mint in a tight
 * loop should cache that state and call the raw builders directly.
 *
 * Slippage is the caller's: `minTokensOut` / `minSolOut` are passed through
 * unchanged. Pump.fun fees are tiered by the fee program, so a client-side
 * quote here would only be approximate.
 */

import type { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { Instruction } from '@ap3x/solana-tx';
import { buildBuyExactSolIn, buildSell } from './instructions/bonding-curve.js';
import { buildPumpSwapBuyExactQuoteIn, buildPumpSwapSell } from './instructions/pumpswap.js';
import { curveState, feeRecipientFor, globalState } from './curve/state.js';
import {
  derivePumpSwapPoolPda,
  protocolFeeRecipientFor,
  pumpSwapGlobalConfig,
  pumpSwapPoolState,
} from './pumpswap/pool-state.js';

export interface UnifiedBuyParams {
  user: PublicKey;
  /** Lamports to spend, exactly. */
  solIn: bigint;
  /** Minimum tokens to receive; the program rejects the trade below this. */
  minTokensOut: bigint;
  /** Token program of the mint (default classic SPL Token). */
  tokenProgram?: PublicKey;
  /** User's token account for the mint (default: ATA). */
  userTokenAccount?: PublicKey;
  /** User's WSOL account, post-graduation only (default: ATA). */
  userQuoteTokenAccount?: PublicKey;
}

export interface UnifiedSellParams {
  user: PublicKey;
  /** Tokens to sell, exactly. */
  tokenAmount: bigint;
  /** Minimum lamports to receive; the program rejects the trade below this. */
  minSolOut: bigint;
  tokenProgram?: PublicKey;
  userTokenAccount?: PublicKey;
  userQuoteTokenAccount?: PublicKey;
}

function buybackRecipient(global: { buybackFeeRecipients: PublicKey[] }): PublicKey {
  const r = global.buybackFeeRecipients[0];
  if (!r) throw new Error('pump.fun Global has no buyback fee recipient');
  return r;
}

async function pumpSwapContext(rpcPool: RpcPool, mint: PublicKey) {
  const [pool, config] = await Promise.all([
    pumpSwapPoolState(rpcPool, derivePumpSwapPoolPda(mint).address),
    pumpSwapGlobalConfig(rpcPool),
  ]);
  const protocolFeeRecipient = protocolFeeRecipientFor(config, pool);
  const buybackFeeRecipient = config.buybackFeeRecipients[0];
  if (!buybackFeeRecipient) throw new Error('PumpSwap GlobalConfig has no buyback fee recipient');
  return { pool, protocolFeeRecipient, buybackFeeRecipient };
}

export async function buy(rpcPool: RpcPool, mint: PublicKey, params: UnifiedBuyParams): Promise<Instruction> {
  const state = await curveState(rpcPool, mint);
  if (!state.complete) {
    const global = await globalState(rpcPool);
    return buildBuyExactSolIn({
      mint,
      user: params.user,
      feeRecipient: feeRecipientFor(global, state),
      creator: state.creator,
      buybackFeeRecipient: buybackRecipient(global),
      spendableSolIn: params.solIn,
      minTokensOut: params.minTokensOut,
      ...(params.tokenProgram ? { tokenProgram: params.tokenProgram } : {}),
      ...(params.userTokenAccount ? { userTokenAccount: params.userTokenAccount } : {}),
    });
  }
  const { pool, protocolFeeRecipient, buybackFeeRecipient } = await pumpSwapContext(rpcPool, mint);
  return buildPumpSwapBuyExactQuoteIn({
    pool,
    user: params.user,
    protocolFeeRecipient,
    buybackFeeRecipient,
    spendableQuoteIn: params.solIn,
    minBaseAmountOut: params.minTokensOut,
    ...(params.tokenProgram ? { baseTokenProgram: params.tokenProgram } : {}),
    ...(params.userTokenAccount ? { userBaseTokenAccount: params.userTokenAccount } : {}),
    ...(params.userQuoteTokenAccount ? { userQuoteTokenAccount: params.userQuoteTokenAccount } : {}),
  });
}

export async function sell(rpcPool: RpcPool, mint: PublicKey, params: UnifiedSellParams): Promise<Instruction> {
  const state = await curveState(rpcPool, mint);
  if (!state.complete) {
    const global = await globalState(rpcPool);
    return buildSell({
      mint,
      user: params.user,
      feeRecipient: feeRecipientFor(global, state),
      creator: state.creator,
      buybackFeeRecipient: buybackRecipient(global),
      amount: params.tokenAmount,
      minSolOutput: params.minSolOut,
      cashback: state.isCashbackCoin,
      ...(params.tokenProgram ? { tokenProgram: params.tokenProgram } : {}),
      ...(params.userTokenAccount ? { userTokenAccount: params.userTokenAccount } : {}),
    });
  }
  const { pool, protocolFeeRecipient, buybackFeeRecipient } = await pumpSwapContext(rpcPool, mint);
  return buildPumpSwapSell({
    pool,
    user: params.user,
    protocolFeeRecipient,
    buybackFeeRecipient,
    baseAmountIn: params.tokenAmount,
    minQuoteAmountOut: params.minSolOut,
    ...(params.tokenProgram ? { baseTokenProgram: params.tokenProgram } : {}),
    ...(params.userTokenAccount ? { userBaseTokenAccount: params.userTokenAccount } : {}),
    ...(params.userQuoteTokenAccount ? { userQuoteTokenAccount: params.userQuoteTokenAccount } : {}),
  });
}

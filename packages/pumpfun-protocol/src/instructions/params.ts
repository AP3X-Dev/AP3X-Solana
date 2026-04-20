/**
 * Typed parameter objects for the pump.fun instruction builders.
 *
 * Each builder (`buildCreate`, `buildBuy`, `buildSell`, `buildPumpSwapSwap`)
 * accepts one of these records and returns a pure `Instruction`
 * (`{ programId, keys, data }`). Callers never assemble the underlying
 * account lists or instruction-data bytes by hand — strategies and the
 * write-path express intent through these records only.
 *
 * Amount fields are `bigint` because the on-chain layouts are all `u64`.
 * Lamport amounts for a single buy/sell can legitimately exceed
 * `Number.MAX_SAFE_INTEGER` over the lifetime of a hot wallet, so we
 * preserve the native precision end-to-end.
 *
 * Slippage fields express floors/ceilings for the client-side quote vs.
 * the on-chain fill:
 *   - `buy`: `maxSolCost` is the largest lamport outlay the user tolerates.
 *   - `sell`: `minSolOutput` is the smallest lamport proceed the user tolerates.
 *   - `pumpSwap swap`: `minAmountOut` is the smallest out-side amount.
 *
 * The on-chain programs enforce these limits; the builders pass them through
 * verbatim.
 */

import type { PublicKey } from '@ap3x/solana-core';

/**
 * Parameters for `buildCreate` — mint a new pump.fun token and initialise
 * its bonding curve.
 *
 *   - `mint` — the new token mint. Usually a freshly generated keypair's
 *     public key; the builder does not create the keypair.
 *   - `payer` — funds rent and fees; must sign the transaction.
 *   - `creator` — the on-chain creator recorded in the bonding-curve
 *     account. Often the same as `payer` but split so a relayer can pay
 *     on behalf of a creator.
 *   - `name` / `symbol` / `uri` — metadata surfaced by pump.fun UIs. The
 *     `uri` points at an off-chain JSON blob (image, description, socials).
 */
export interface CreateParams {
  mint: PublicKey;
  payer: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

/**
 * Parameters for `buildBuy` — bonding-curve buy.
 *
 *   - `mint` — the pump.fun token being bought.
 *   - `buyer` — the wallet funding the buy and receiving tokens. Signer.
 *   - `amount` — token units (base-unit precision) to receive.
 *   - `maxSolCost` — slippage ceiling in lamports. The program rejects the
 *     fill if the actual cost exceeds this.
 */
export interface BuyParams {
  mint: PublicKey;
  buyer: PublicKey;
  amount: bigint;
  maxSolCost: bigint;
}

/**
 * Parameters for `buildSell` — bonding-curve sell.
 *
 *   - `mint` — the pump.fun token being sold.
 *   - `seller` — the wallet selling tokens and receiving SOL. Signer.
 *   - `amount` — token units (base-unit precision) to sell.
 *   - `minSolOutput` — slippage floor in lamports. The program rejects the
 *     fill if proceeds fall below this.
 */
export interface SellParams {
  mint: PublicKey;
  seller: PublicKey;
  amount: bigint;
  minSolOutput: bigint;
}

/**
 * Parameters for `buildPumpSwapSwap` — post-graduation swap on the
 * PumpSwap AMM.
 *
 * Direction is expressed by `side`: `'buy'` spends the quote mint
 * (SOL / wSOL) to receive `baseMint`; `'sell'` spends `baseMint` to
 * receive the quote mint.
 *
 *   - `pool` — the PumpSwap pool account (derived or known).
 *   - `baseMint` / `quoteMint` — the pool's mint pair.
 *   - `user` — the wallet initiating the swap. Signer.
 *   - `side` — trade direction.
 *   - `amountIn` — input amount in base-unit precision of the in-side mint.
 *   - `minAmountOut` — slippage floor on the out-side mint.
 */
export interface PumpSwapSwapParams {
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  user: PublicKey;
  side: 'buy' | 'sell';
  amountIn: bigint;
  minAmountOut: bigint;
}

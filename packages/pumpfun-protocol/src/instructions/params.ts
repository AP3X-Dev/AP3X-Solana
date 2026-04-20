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
 *   - `sell`: `minSolOut` is the smallest lamport proceed the user tolerates.
 *   - `pumpSwap swap`: `minOutputAmount` is the smallest out-side amount.
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
 *   - `user` — the wallet funding the buy and receiving tokens. Signer.
 *   - `solIn` — lamports the user commits to spend on this buy (pre-slippage
 *     notional). Encoded as the first `u64` argument; the program treats it
 *     as the exact lamport input for the bonding-curve quote.
 *   - `maxSolCost` — slippage ceiling in lamports. The program rejects the
 *     fill if the actual cost exceeds this.
 *   - `userTokenAccount` — the caller's ATA for `mint`. The builder does not
 *     derive it: strategies typically ensure-create the ATA upstream
 *     (idempotent) and already have the address. Passing it through keeps
 *     the builder pure.
 */
export interface BuyParams {
  mint: PublicKey;
  user: PublicKey;
  solIn: bigint;
  maxSolCost: bigint;
  userTokenAccount: PublicKey;
}

/**
 * Parameters for `buildSell` — bonding-curve sell.
 *
 *   - `mint` — the pump.fun token being sold.
 *   - `user` — the wallet selling tokens and receiving SOL. Signer.
 *   - `tokenAmount` — token units (base-unit precision) to sell. Encoded as
 *     the first `u64` argument.
 *   - `minSolOut` — slippage floor in lamports. The program rejects the fill
 *     if proceeds fall below this.
 *   - `userTokenAccount` — the caller's ATA for `mint`. Same caller-supplied
 *     convention as {@link BuyParams}.
 */
export interface SellParams {
  mint: PublicKey;
  user: PublicKey;
  tokenAmount: bigint;
  minSolOut: bigint;
  userTokenAccount: PublicKey;
}

/**
 * Parameters for `buildPumpSwapSwap` — post-graduation swap on the
 * PumpSwap AMM.
 *
 * Direction is expressed implicitly by `inputMint` vs. `outputMint`: a
 * SOL→token buy passes wSOL as `inputMint`; a token→SOL sell reverses them.
 * The builder is agnostic to which side is "base" and which is "quote" —
 * callers resolve that from the pool state before calling.
 *
 *   - `pool` — the PumpSwap pool account (derived or known).
 *   - `user` — the wallet initiating the swap. Signer.
 *   - `inputMint` / `outputMint` — the two sides of the swap. Must differ.
 *   - `inputAmount` — input amount in base-unit precision of `inputMint`.
 *   - `minOutputAmount` — slippage floor on `outputMint`. The program rejects
 *     the fill if the actual out falls below this.
 *   - `userInputAccount` / `userOutputAccount` — the caller's ATAs for
 *     `inputMint` and `outputMint` respectively. Passed through for the same
 *     reason as `userTokenAccount` in {@link BuyParams}.
 */
export interface PumpSwapSwapParams {
  pool: PublicKey;
  user: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputAmount: bigint;
  minOutputAmount: bigint;
  userInputAccount: PublicKey;
  userOutputAccount: PublicKey;
}

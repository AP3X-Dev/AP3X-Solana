import type { PublicKey } from '@ap3x/solana-core';

/**
 * Builder inputs. Everything the chain can derive (PDAs, program ids,
 * associated token accounts) is derived from the vendored IDL; these carry
 * only what must be read from on-chain state or chosen by the caller.
 *
 * `tokenProgram` / `*TokenProgram` default to the classic SPL Token program;
 * pass the Token-2022 program id for Token-2022 mints (created via
 * `create_v2`). User token accounts default to the user's ATA.
 */

/** Legacy `create` (Metaplex metadata, SPL Token mint). */
export interface CreateParams {
  /** New mint keypair's address — signs the transaction. */
  mint: PublicKey;
  /** Fee payer and signer (`user` in the IDL). */
  payer: PublicKey;
  /** Address credited with creator fees. */
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

/** Accounts shared by bonding-curve trades. */
export interface BondingCurveTradeAccounts {
  mint: PublicKey;
  user: PublicKey;
  /** Fee recipient accepted for this coin — see `feeRecipientFor` (mayhem-mode coins need a reserved one). */
  feeRecipient: PublicKey;
  /** `BondingCurve.creator` (see `curveState`); seeds the creator vault. */
  creator: PublicKey;
  /** One of `Global.buyback_fee_recipients` (see `globalState`). Required since the April 2026 upgrade. */
  buybackFeeRecipient: PublicKey;
  tokenProgram?: PublicKey;
  userTokenAccount?: PublicKey;
}

/** `buy`: receive exactly `amount` tokens, paying at most `maxSolCost` lamports. */
export interface BuyParams extends BondingCurveTradeAccounts {
  amount: bigint;
  maxSolCost: bigint;
  trackVolume?: boolean;
}

/** `buy_exact_sol_in`: spend exactly `spendableSolIn` lamports for at least `minTokensOut`. */
export interface BuyExactSolInParams extends BondingCurveTradeAccounts {
  spendableSolIn: bigint;
  minTokensOut: bigint;
  trackVolume?: boolean;
}

/** `sell`: sell exactly `amount` tokens for at least `minSolOutput` lamports. */
export interface SellParams extends BondingCurveTradeAccounts {
  amount: bigint;
  minSolOutput: bigint;
  /**
   * `BondingCurve.is_cashback_coin`. When true the seller's volume
   * accumulator is passed so the creator fee accrues to the seller.
   */
  cashback?: boolean;
}

/**
 * Accounts shared by the v2 bonding-curve trades, which name the curve's
 * quote mint explicitly. For SOL curves the quote mint is WSOL and the
 * user's WSOL account must hold the quote (create it, transfer SOL in,
 * `syncNativeIx`, and close it afterwards). That makes a v2 SOL trade larger
 * and costlier than the legacy instructions; prefer those for SOL curves.
 */
export interface BondingCurveV2TradeAccounts {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  user: PublicKey;
  feeRecipient: PublicKey;
  /** One of `Global.buyback_fee_recipients`. */
  buybackFeeRecipient: PublicKey;
  /** `BondingCurve.creator`; seeds the creator vault. */
  creator: PublicKey;
  baseTokenProgram?: PublicKey;
  quoteTokenProgram?: PublicKey;
  userBaseTokenAccount?: PublicKey;
  userQuoteTokenAccount?: PublicKey;
}

/** `buy_v2`: receive exactly `amount` tokens for at most `maxSolCost` of the quote. */
export interface BuyV2Params extends BondingCurveV2TradeAccounts {
  amount: bigint;
  maxSolCost: bigint;
}

/** `buy_exact_quote_in_v2`: spend exactly `spendableQuoteIn` for at least `minTokensOut`. */
export interface BuyExactQuoteInV2Params extends BondingCurveV2TradeAccounts {
  spendableQuoteIn: bigint;
  minTokensOut: bigint;
}

/** `sell_v2`: sell exactly `amount` tokens for at least `minSolOutput` of the quote. */
export interface SellV2Params extends BondingCurveV2TradeAccounts {
  amount: bigint;
  minSolOutput: bigint;
}

/** The pool fields a PumpSwap trade needs (see `pumpSwapPoolState`). */
export interface PumpSwapPoolAccounts {
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  coinCreator: PublicKey;
  /** `Pool.is_cashback_coin`. */
  isCashbackCoin?: boolean;
}

/** Accounts shared by PumpSwap trades. */
export interface PumpSwapTradeAccounts {
  pool: PumpSwapPoolAccounts;
  user: PublicKey;
  /** Protocol fee recipient accepted for this pool — see `protocolFeeRecipientFor`. */
  protocolFeeRecipient: PublicKey;
  /** One of `GlobalConfig.buyback_fee_recipients`. Required since the April 2026 upgrade. */
  buybackFeeRecipient: PublicKey;
  baseTokenProgram?: PublicKey;
  quoteTokenProgram?: PublicKey;
  userBaseTokenAccount?: PublicKey;
  userQuoteTokenAccount?: PublicKey;
}

/** PumpSwap `buy`: receive exactly `baseAmountOut`, paying at most `maxQuoteAmountIn`. */
export interface PumpSwapBuyParams extends PumpSwapTradeAccounts {
  baseAmountOut: bigint;
  maxQuoteAmountIn: bigint;
  trackVolume?: boolean;
}

/** PumpSwap `buy_exact_quote_in`: spend exactly `spendableQuoteIn` for at least `minBaseAmountOut`. */
export interface PumpSwapBuyExactQuoteInParams extends PumpSwapTradeAccounts {
  spendableQuoteIn: bigint;
  minBaseAmountOut: bigint;
  trackVolume?: boolean;
}

/** PumpSwap `sell`: sell exactly `baseAmountIn` for at least `minQuoteAmountOut`. */
export interface PumpSwapSellParams extends PumpSwapTradeAccounts {
  baseAmountIn: bigint;
  minQuoteAmountOut: bigint;
}

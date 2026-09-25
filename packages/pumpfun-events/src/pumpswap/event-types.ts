import type { PublicKey } from '@ap3x/solana-core';

/**
 * Events emitted by the PumpSwap AMM program. Layouts follow the vendored IDL
 * (`idl/pump_amm.json`). PumpSwap has separate buy and sell instructions and
 * events; "base" is the pump token and "quote" is usually wrapped SOL. Fields
 * appended after an event first shipped are optional. Every IDL field present
 * is included on the record (camelCased).
 */
export type PumpSwapEvent =
  | PumpSwapBuyEvent
  | PumpSwapSellEvent
  | PumpSwapDepositEvent
  | PumpSwapWithdrawEvent
  | PumpSwapCreatePoolEvent
  | PumpSwapOtherEvent;

interface PumpSwapTradeFields {
  timestamp: bigint;
  userBaseTokenReserves: bigint;
  userQuoteTokenReserves: bigint;
  poolBaseTokenReserves: bigint;
  poolQuoteTokenReserves: bigint;
  lpFeeBasisPoints: bigint;
  lpFee: bigint;
  protocolFeeBasisPoints: bigint;
  protocolFee: bigint;
  pool: PublicKey;
  user: PublicKey;
  userBaseTokenAccount: PublicKey;
  userQuoteTokenAccount: PublicKey;
  protocolFeeRecipient: PublicKey;
  protocolFeeRecipientTokenAccount: PublicKey;
  coinCreator?: PublicKey;
  coinCreatorFeeBasisPoints?: bigint;
  coinCreatorFee?: bigint;
  [field: string]: unknown;
}

export interface PumpSwapBuyEvent extends PumpSwapTradeFields {
  kind: 'pumpswap.buy';
  baseAmountOut: bigint;
  maxQuoteAmountIn: bigint;
  quoteAmountIn: bigint;
  quoteAmountInWithLpFee: bigint;
  userQuoteAmountIn: bigint;
}

export interface PumpSwapSellEvent extends PumpSwapTradeFields {
  kind: 'pumpswap.sell';
  baseAmountIn: bigint;
  minQuoteAmountOut: bigint;
  quoteAmountOut: bigint;
  quoteAmountOutWithoutLpFee: bigint;
  userQuoteAmountOut: bigint;
}

interface PumpSwapLiquidityFields {
  timestamp: bigint;
  userBaseTokenReserves: bigint;
  userQuoteTokenReserves: bigint;
  poolBaseTokenReserves: bigint;
  poolQuoteTokenReserves: bigint;
  lpMintSupply: bigint;
  pool: PublicKey;
  user: PublicKey;
  userBaseTokenAccount: PublicKey;
  userQuoteTokenAccount: PublicKey;
  userPoolTokenAccount: PublicKey;
  [field: string]: unknown;
}

export interface PumpSwapDepositEvent extends PumpSwapLiquidityFields {
  kind: 'pumpswap.deposit';
  lpTokenAmountOut: bigint;
  maxBaseAmountIn: bigint;
  maxQuoteAmountIn: bigint;
  baseAmountIn: bigint;
  quoteAmountIn: bigint;
}

export interface PumpSwapWithdrawEvent extends PumpSwapLiquidityFields {
  kind: 'pumpswap.withdraw';
  lpTokenAmountIn: bigint;
  minBaseAmountOut: bigint;
  minQuoteAmountOut: bigint;
  baseAmountOut: bigint;
  quoteAmountOut: bigint;
}

export interface PumpSwapCreatePoolEvent {
  kind: 'pumpswap.create_pool';
  timestamp: bigint;
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseMintDecimals: number;
  quoteMintDecimals: number;
  baseAmountIn: bigint;
  quoteAmountIn: bigint;
  poolBaseAmount: bigint;
  poolQuoteAmount: bigint;
  minimumLiquidity: bigint;
  initialLiquidity: bigint;
  lpTokenAmountOut: bigint;
  poolBump: number;
  pool: PublicKey;
  lpMint: PublicKey;
  coinCreator?: PublicKey;
  [field: string]: unknown;
}

/** Any other event in the IDL, decoded generically. */
export interface PumpSwapOtherEvent {
  kind: 'pumpswap.other';
  eventName: string;
  fields: Record<string, unknown>;
}

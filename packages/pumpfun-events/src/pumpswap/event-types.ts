import type { PublicKey } from '@ap3x/solana-core';

export type PumpSwapEvent =
  | PumpSwapSwapEvent
  | PumpSwapAddLiquidityEvent
  | PumpSwapRemoveLiquidityEvent
  | PumpSwapAdminEvent;

export interface PumpSwapSwapEvent {
  kind: 'pumpfun.swap';
  pool: PublicKey;
  user: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputAmount: bigint;
  outputAmount: bigint;
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
  timestamp: bigint;
}

export interface PumpSwapAddLiquidityEvent {
  kind: 'pumpfun.add_liquidity';
  pool: PublicKey;
  user: PublicKey;
  baseAmount: bigint;
  quoteAmount: bigint;
  lpTokens: bigint;
  timestamp: bigint;
}

export interface PumpSwapRemoveLiquidityEvent {
  kind: 'pumpfun.remove_liquidity';
  pool: PublicKey;
  user: PublicKey;
  baseAmount: bigint;
  quoteAmount: bigint;
  lpTokens: bigint;
  timestamp: bigint;
}

export interface PumpSwapAdminEvent {
  kind: 'pumpfun.admin_set_params';
  authority: PublicKey;
  newFeeBasisPoints: number;
  timestamp: bigint;
}

import type { PublicKey } from '@ap3x/solana-core';

export type PumpFunBondingCurveEvent =
  | PumpFunCreateEvent
  | PumpFunTradeEvent
  | PumpFunCompleteEvent
  | PumpFunSetParamsEvent
  | PumpFunCreatorFeeEvent
  | PumpFunMigrateEvent;

export interface PumpFunCreateEvent {
  kind: 'pumpfun.create';
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  bondingCurve: PublicKey;
  initialVirtualSolReserves: bigint;
  initialVirtualTokenReserves: bigint;
  timestamp: bigint;
}

export interface PumpFunTradeEvent {
  kind: 'pumpfun.trade';
  mint: PublicKey;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: PublicKey;
  timestamp: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

export interface PumpFunCompleteEvent {
  kind: 'pumpfun.complete';
  mint: PublicKey;
  user: PublicKey;
  bondingCurve: PublicKey;
  timestamp: bigint;
}

export interface PumpFunSetParamsEvent {
  kind: 'pumpfun.set_params';
  feeRecipient: PublicKey;
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  feeBasisPoints: number;
}

export interface PumpFunCreatorFeeEvent {
  kind: 'pumpfun.creator_fee';
  mint: PublicKey;
  creator: PublicKey;
  solAmount: bigint;
  timestamp: bigint;
}

export interface PumpFunMigrateEvent {
  kind: 'pumpfun.migrate';
  mint: PublicKey;
  bondingCurve: PublicKey;
  pool: PublicKey;
  timestamp: bigint;
}

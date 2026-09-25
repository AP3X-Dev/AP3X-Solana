import type { PublicKey } from '@ap3x/solana-core';

/**
 * Events emitted by the pump.fun bonding curve program. Layouts follow the
 * vendored IDL (`idl/pump.json`). Fields the program appended after an event
 * first shipped are optional: older transactions don't carry them. Every IDL
 * field that is present is included on the record (camelCased), including
 * ones not listed on the interface.
 */
export type PumpFunBondingCurveEvent =
  | PumpFunCreateEvent
  | PumpFunTradeEvent
  | PumpFunCompleteEvent
  | PumpFunCompletePumpAmmMigrationEvent
  | PumpFunCollectCreatorFeeEvent
  | PumpFunSetParamsEvent
  | PumpFunOtherEvent;

export interface PumpFunCreateEvent {
  kind: 'pumpfun.create';
  name: string;
  symbol: string;
  uri: string;
  mint: PublicKey;
  bondingCurve: PublicKey;
  /** The signer that sent the create instruction. */
  user: PublicKey;
  /** Creator credited with creator fees. */
  creator?: PublicKey;
  timestamp?: bigint;
  virtualTokenReserves?: bigint;
  virtualSolReserves?: bigint;
  realTokenReserves?: bigint;
  tokenTotalSupply?: bigint;
  tokenProgram?: PublicKey;
  [field: string]: unknown;
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
  feeRecipient?: PublicKey;
  feeBasisPoints?: bigint;
  fee?: bigint;
  creator?: PublicKey;
  creatorFeeBasisPoints?: bigint;
  creatorFee?: bigint;
  /** Instruction that produced the trade, e.g. `buy`, `buy_exact_sol_in`, `sell`. */
  ixName?: string;
  [field: string]: unknown;
}

export interface PumpFunCompleteEvent {
  kind: 'pumpfun.complete';
  user: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  timestamp: bigint;
  [field: string]: unknown;
}

/** Emitted when a completed curve migrates into a PumpSwap pool. */
export interface PumpFunCompletePumpAmmMigrationEvent {
  kind: 'pumpfun.complete_pump_amm_migration';
  user: PublicKey;
  mint: PublicKey;
  mintAmount: bigint;
  solAmount: bigint;
  poolMigrationFee: bigint;
  bondingCurve: PublicKey;
  timestamp: bigint;
  pool: PublicKey;
  [field: string]: unknown;
}

export interface PumpFunCollectCreatorFeeEvent {
  kind: 'pumpfun.collect_creator_fee';
  timestamp: bigint;
  creator: PublicKey;
  creatorFee: bigint;
  [field: string]: unknown;
}

export interface PumpFunSetParamsEvent {
  kind: 'pumpfun.set_params';
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  finalRealSolReserves: bigint;
  tokenTotalSupply: bigint;
  feeBasisPoints: bigint;
  [field: string]: unknown;
}

/** Any other event in the IDL, decoded generically. */
export interface PumpFunOtherEvent {
  kind: 'pumpfun.other';
  /** IDL event name, e.g. `ExtendAccountEvent`. */
  eventName: string;
  fields: Record<string, unknown>;
}

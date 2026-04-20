import type { PublicKey } from '@ap3x/solana-core';

export type LotSource =
  | 'trade'
  | 'airdrop'
  | 'transfer-in'
  | 'cold-start-reconstructed'
  | 'cold-start-unresolved';

export interface Lot {
  amount: bigint;
  costBasisLamports: bigint;
  acquiredSlot: number;
  acquiredSig: string;
  source: LotSource;
  reconstructedAt?: number;
  basisUnresolved?: boolean;
}

export interface Position {
  mint: PublicKey;
  walletAddress: PublicKey;
  lots: Lot[];
  lastUpdatedSlot: number;
}

export interface LandedTrade {
  signature: string;
  slot: number;
  wallet: PublicKey;
  mint: PublicKey;
  amountDelta: bigint;
  solFlowLamports: bigint;
  feeLamports: bigint;
  source: 'executor' | 'external';
}

export interface PositionChange {
  wallet: PublicKey;
  mint: PublicKey;
  before: Position | null;
  after: Position;
  reason: 'apply-landed-trade' | 'cold-start' | 'reconcile' | 'manual-correction';
}

export interface RealizedPnlEvent {
  wallet: PublicKey;
  mint: PublicKey;
  realized: bigint;
  costBasis: bigint;
  proceeds: bigint;
  basisUnresolved: boolean;
  slot: number;
}

export interface DriftEvent {
  wallet: PublicKey;
  mint: PublicKey;
  expected: bigint;
  observed: bigint;
  diff: bigint;
  lastKnownLandedSig: string | null;
}

export interface CostBasisIncompleteEvent {
  wallet: PublicKey;
  mint: PublicKey;
  unaccountedAmount: bigint;
  oldestSlotWalked: number;
}

export interface ObserveOpts {
  method?: 'fifo' | 'lifo' | 'avg-cost';
  lookbackDays?: number;
}

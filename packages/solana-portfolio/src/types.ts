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

/** One receipt aggregate per wallet/mint. Split instruction legs must be aggregated before applying. */
export interface LandedTrade {
  signature: string;
  slot: number;
  wallet: PublicKey;
  mint: PublicKey;
  amountDelta: bigint;
  /** Per-mint cash flow; null when the receipt does not establish its allocation. */
  solFlowLamports: bigint | null;
  /** Receipt-wide observation, never a per-mint acquisition cost or sale proceeds. */
  transactionNetSolFlowLamports?: bigint;
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
  realized: bigint | null;
  costBasis: bigint | null;
  proceeds: bigint | null;
  basisUnresolved: boolean;
  slot: number;
}

/** Attribution status of stored disposals; this is not complete chain-history coverage. */
export interface RealizedPnlStatus {
  knownRealizedLamports: bigint;
  complete: boolean;
  unresolvedSignatures: string[];
}

export class IncompletePnlError extends Error {
  readonly code = 'portfolio.pnl_unresolved';
  constructor(readonly signatures: readonly string[]) {
    super('PnL is unresolved: acquisition basis or settlement proceeds are not established');
    this.name = 'IncompletePnlError';
  }
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

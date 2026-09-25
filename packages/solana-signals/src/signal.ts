import type { PublicKey } from '@ap3x/solana-core';
import type { ProgramLogChunk } from '@ap3x/solana-events';

export interface Signal<TDecoded = unknown> {
  signalId: string;
  ts: number;
  slot: number;
  signature: string;
  programId: PublicKey;
  kind: string;
  venue?: string;
  decoded: TDecoded;
  raw: ProgramLogChunk;
  /**
   * Optional schema/semantics version of this signal kind. Producers stamp it
   * so consumers that pin a version can reject mismatched signals at the bus
   * layer — required for honest backtests and for cross-version drift
   * detection during rolling rollouts.
   */
  signalVersion?: string;
}

export interface GapEvent {
  fromSlot: number;
  toSlot: number;
  reason: 'skip' | 'reorg' | 'source-restart';
}

/** A decoded event's own kind (e.g. `pumpfun.trade`), not the registry envelope's. */
export function eventKind(data: unknown): string {
  const kind = (data as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : 'decoded';
}

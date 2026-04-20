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
}

export interface GapEvent {
  fromSlot: number;
  toSlot: number;
  reason: 'skip' | 'reorg' | 'source-restart';
}

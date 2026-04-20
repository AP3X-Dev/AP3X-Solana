import type { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';
import type { TradeIntent, ExecutionResult } from '@ap3x/solana-executor';
import type { PositionChange } from '@ap3x/solana-portfolio';
import type { StrategyContext } from './context.js';
import type { SignalFilter } from './filter.js';

export type Decision = TradeIntent;
export type HookPhase =
  | 'onStart'
  | 'onSignal'
  | 'onExecutionResult'
  | 'onPositionChange'
  | 'onBalanceChange'
  | 'onTick'
  | 'onShutdown';

export interface BalanceDelta {
  mint: PublicKey;
  delta: bigint;
  preAmount: bigint;
  postAmount: bigint;
  slot: number;
}

export abstract class Strategy {
  abstract readonly name: string;
  abstract readonly filters: SignalFilter[];

  onStart?(ctx: StrategyContext): Promise<void>;
  onShutdown?(ctx: StrategyContext): Promise<void>;

  abstract onSignal(signal: Signal, ctx: StrategyContext): Promise<Decision | null>;
  onExecutionResult?(result: ExecutionResult, ctx: StrategyContext): Promise<void>;
  onPositionChange?(change: PositionChange, ctx: StrategyContext): Promise<void>;
  onBalanceChange?(wallet: string, deltas: BalanceDelta[], ctx: StrategyContext): Promise<void>;
  onTick?(tsMs: number, ctx: StrategyContext): Promise<void>;

  /** Synchronous reporter — must NOT await. Called on any uncaught hook error. */
  onError?(err: Error, phase: HookPhase, ctx: StrategyContext): void;
}

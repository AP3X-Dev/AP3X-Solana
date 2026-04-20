/**
 * _helpers.ts — shared test fakes and utilities for @ap3x/solana-strategy
 * integration tests (T44).
 *
 * Not part of the package surface — Vitest picks this up only because it lives
 * in tests/ and is imported by the test files. It is excluded from the package
 * exports and from tsup's build input.
 */

import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';
import { SignalQueue } from '@ap3x/solana-signals';
import type { Signal } from '@ap3x/solana-signals';
import type { ExecutionResult, TradeIntent } from '@ap3x/solana-executor';
import type { LandedTrade, PositionChange, Position } from '@ap3x/solana-portfolio';

import type { ExecutorLike, PortfolioLike } from '../src/runtime.js';
import type { StrategyStateStore } from '../src/context.js';

// ---------------------------------------------------------------------------
// Known valid base58 Solana addresses
// ---------------------------------------------------------------------------

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// ---------------------------------------------------------------------------
// FakeExecutor — minimal ExecutorLike for integration tests
// ---------------------------------------------------------------------------

export class FakeExecutor extends EventEmitter implements ExecutorLike {
  readonly submittedIntents: TradeIntent[] = [];
  submitResult: ExecutionResult = {
    kind: 'timeout',
    intentId: 'fake',
    signature: 'fake-sig',
    submitterUsed: 'rpc',
  };

  async submit(intent: TradeIntent): Promise<ExecutionResult> {
    this.submittedIntents.push(intent);
    return { ...this.submitResult, intentId: intent.intentId };
  }
}

// ---------------------------------------------------------------------------
// FakePortfolio — minimal PortfolioLike for integration tests
// ---------------------------------------------------------------------------

export class FakePortfolio extends EventEmitter implements PortfolioLike {
  readonly appliedTrades: LandedTrade[] = [];
  readonly changes: PositionChange[] = [];

  async applyLandedTrade(trade: LandedTrade): Promise<PositionChange[]> {
    this.appliedTrades.push(trade);
    const pos: Position = {
      mint: trade.mint,
      walletAddress: trade.wallet,
      lots: [],
      lastUpdatedSlot: trade.slot,
    };
    const change: PositionChange = {
      wallet: trade.wallet,
      mint: trade.mint,
      before: null,
      after: pos,
      reason: 'apply-landed-trade',
    };
    this.changes.push(change);
    this.emit('change', change);
    return [change];
  }

  // PortfolioReadApi stubs
  async getPosition(_wallet: PublicKey, _mint: PublicKey): Promise<Position | null> { return null; }
  async getAllPositions(_wallet: PublicKey): Promise<Position[]> { return []; }
  async getRealizedPnl(_wallet: PublicKey, _mint: PublicKey): Promise<bigint> { return 0n; }
  async getUnrealizedPnl(_wallet: PublicKey, _mint: PublicKey, _p: bigint): Promise<bigint> { return 0n; }
}

// ---------------------------------------------------------------------------
// MemStateStore — in-memory StrategyStateStore
// ---------------------------------------------------------------------------

export class MemStateStore implements StrategyStateStore {
  private readonly store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> { return (this.store.get(key) as T) ?? null; }
  async set<T>(key: string, value: T): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.store.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
}

// ---------------------------------------------------------------------------
// makeFakeRpcPool / makeFakeResolveWallet
// ---------------------------------------------------------------------------

export function makeFakeRpcPool() {
  return { call: vi.fn().mockResolvedValue(null) };
}

export function makeFakeResolveWallet(address?: PublicKey) {
  const pk = address ?? PublicKey.fromBase58(TOKEN_PROGRAM);
  return async (_name: string) =>
    ({
      address: pk,
      role: 'test',
      sign: vi.fn(),
      signTransaction: vi.fn(),
      isLocked: false,
      _lock: () => {},
      toJSON: () => ({ address: pk.toBase58(), role: 'test', locked: false }),
    }) as unknown as import('@ap3x/solana-vault').WalletHandle;
}

// ---------------------------------------------------------------------------
// makeRuntimeOpts — base StrategyRuntimeOpts factory
// ---------------------------------------------------------------------------

export function makeRuntimeOpts(
  overrides: Partial<import('../src/runtime.js').StrategyRuntimeOpts> = {},
): {
  opts: import('../src/runtime.js').StrategyRuntimeOpts;
  executor: FakeExecutor;
  portfolio: FakePortfolio;
} {
  const executor = new FakeExecutor();
  const portfolio = new FakePortfolio();
  const opts: import('../src/runtime.js').StrategyRuntimeOpts = {
    signalQueue: new SignalQueue(),
    executor,
    portfolio,
    resolveWallet: makeFakeResolveWallet(),
    rpcPool: makeFakeRpcPool() as unknown as import('../src/landed-trade-adapter.js').RpcPoolLike,
    stateStoreFactory: () => new MemStateStore(),
    tickIntervalMs: 999_999, // effectively disabled
    ...overrides,
  };
  return { opts, executor, portfolio };
}

// ---------------------------------------------------------------------------
// makeSignal — test signal factory
// ---------------------------------------------------------------------------

export function makeSignal(
  kind: string,
  signalId = `sig-${kind}-${Math.random().toString(36).slice(2)}`,
  slot = 100,
): Signal {
  return {
    signalId,
    ts: 1_000_000,
    slot,
    signature: `tx-${signalId}`,
    programId: PublicKey.fromBase58(SYSTEM_PROGRAM),
    kind,
    decoded: {},
    raw: {
      slot,
      signature: `tx-${signalId}`,
      programId: SYSTEM_PROGRAM,
      logs: [],
    } as unknown as Signal['raw'],
  };
}

// ---------------------------------------------------------------------------
// writeFixtureGzip — write a deterministic gzipped JSONL fixture file
// ---------------------------------------------------------------------------

/**
 * Write signals as a gzipped JSONL file to a temp directory.
 * Returns the absolute file path.
 *
 * Signal.programId is serialised as a base58 string — FixtureSignalSource
 * reconstructs the PublicKey on read.
 */
export function writeFixtureGzip(signals: Signal[], name = 'fixture.jsonl.gz'): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `ap3x-strategy-t44-${process.pid}-${Date.now()}`,
  );
  mkdirSync(tmpDir, { recursive: true });

  const lines = signals.map((s) =>
    JSON.stringify({
      ...s,
      programId: s.programId.toBase58(),
      raw: s.raw
        ? {
            ...s.raw,
            programId:
              typeof (s.raw as unknown as { programId: unknown }).programId === 'string'
                ? (s.raw as unknown as { programId: string }).programId
                : s.programId.toBase58(),
          }
        : undefined,
    }),
  );
  const jsonl = lines.join('\n') + '\n';
  const gz = gzipSync(Buffer.from(jsonl, 'utf8'));
  const fpath = path.join(tmpDir, name);
  writeFileSync(fpath, gz);
  return fpath;
}

// ---------------------------------------------------------------------------
// drainQueue — wait for signal queue to empty and instance queues to settle
// ---------------------------------------------------------------------------

export async function drainQueue(queue: SignalQueue): Promise<void> {
  await queue.drain();
  await new Promise<void>((res) => setImmediate(res));
  await new Promise<void>((res) => setImmediate(res));
}

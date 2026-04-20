import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';
import { SPL_TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import type { StrategyContext } from '@ap3x/solana-strategy';
import { matches } from '@ap3x/solana-strategy';
import { WatcherStrategy } from './watcher-strategy.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WATCHED = '11111111111111111111111111111112';
const OTHER   = '11111111111111111111111111111111';

const watchedPk = PublicKey.fromBase58(WATCHED);
const otherPk   = PublicKey.fromBase58(OTHER);
const splPk     = PublicKey.fromBase58(TOKEN_PROGRAM);

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    signalId: 'test-sig',
    ts: 1000,
    slot: 42,
    signature: 'abc123',
    programId: splPk,
    kind: 'spl.transfer',
    decoded: { source: otherPk, dest: watchedPk, amount: 500 },
    raw: {} as any,
    ...overrides,
  };
}

const ctx = {} as unknown as StrategyContext;

describe('WatcherStrategy — filters', () => {
  it('has a single filter matching spl.transfer + SPL_TOKEN_PROGRAM_ID', () => {
    const strategy = new WatcherStrategy(new Set([WATCHED]));
    expect(strategy.filters).toHaveLength(1);
    const f = strategy.filters[0]!;
    expect(f.kind).toBe('spl.transfer');
    expect(matches(f, makeSignal())).toBe(true);
  });

  it('filter programId is SPL_TOKEN_PROGRAM_ID', () => {
    const strategy = new WatcherStrategy(new Set([WATCHED]));
    const f = strategy.filters[0]!;
    // programId in the filter should equal SPL_TOKEN_PROGRAM_ID
    const sigWithSpl = makeSignal({ programId: SPL_TOKEN_PROGRAM_ID });
    const sigWithOther = makeSignal({ programId: otherPk });
    expect(matches(f, sigWithSpl)).toBe(true);
    expect(matches(f, sigWithOther)).toBe(false);
  });
});

describe('WatcherStrategy — name', () => {
  it('has name spl-watcher', () => {
    const strategy = new WatcherStrategy(new Set());
    expect(strategy.name).toBe('spl-watcher');
  });
});

describe('WatcherStrategy — onSignal', () => {
  it('emits JSON when dest is in watched set', async () => {
    const emit = vi.fn();
    const strategy = new WatcherStrategy(new Set([WATCHED]), emit);
    const result = await strategy.onSignal(makeSignal(), ctx);
    expect(emit).toHaveBeenCalledOnce();
    const parsed = JSON.parse(emit.mock.calls[0]![0]);
    expect(parsed).toMatchObject({
      wallet: WATCHED,
      sig: 'abc123',
      slot: 42,
      amount: '500',
    });
    expect(result).toBeNull();
  });

  it('does not emit when dest is not in watched set', async () => {
    const emit = vi.fn();
    const strategy = new WatcherStrategy(new Set([OTHER]), emit);
    // watchedPk is NOT in the watched set (we're watching OTHER, dest is WATCHED)
    await strategy.onSignal(makeSignal(), ctx);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not emit when decoded has no dest', async () => {
    const emit = vi.fn();
    const strategy = new WatcherStrategy(new Set([WATCHED]), emit);
    await strategy.onSignal(makeSignal({ decoded: { source: otherPk, amount: 100 } }), ctx);
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits correct amount string for bigint input', async () => {
    const emit = vi.fn();
    const strategy = new WatcherStrategy(new Set([WATCHED]), emit);
    await strategy.onSignal(
      makeSignal({ decoded: { source: otherPk, dest: watchedPk, amount: 999999999999999n } }),
      ctx,
    );
    const parsed = JSON.parse(emit.mock.calls[0]![0]);
    expect(parsed.amount).toBe('999999999999999');
  });

  it('emits correct amount string for number input', async () => {
    const emit = vi.fn();
    const strategy = new WatcherStrategy(new Set([WATCHED]), emit);
    await strategy.onSignal(
      makeSignal({ decoded: { source: otherPk, dest: watchedPk, amount: 12345 } }),
      ctx,
    );
    const parsed = JSON.parse(emit.mock.calls[0]![0]);
    expect(parsed.amount).toBe('12345');
  });

  it('emits amount as "?" when amount is undefined', async () => {
    const emit = vi.fn();
    const strategy = new WatcherStrategy(new Set([WATCHED]), emit);
    await strategy.onSignal(
      makeSignal({ decoded: { source: otherPk, dest: watchedPk } }),
      ctx,
    );
    const parsed = JSON.parse(emit.mock.calls[0]![0]);
    expect(parsed.amount).toBe('?');
  });

  it('returns null for every signal (observer-only strategy)', async () => {
    const emit = vi.fn();
    const strategy = new WatcherStrategy(new Set([WATCHED]), emit);
    const r1 = await strategy.onSignal(makeSignal(), ctx);
    const r2 = await strategy.onSignal(makeSignal({ decoded: { dest: otherPk } }), ctx);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});

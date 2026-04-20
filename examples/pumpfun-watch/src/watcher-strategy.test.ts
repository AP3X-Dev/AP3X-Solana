import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';
import type { StrategyContext } from '@ap3x/solana-strategy';
import { matches } from '@ap3x/solana-strategy';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';
import { WatcherStrategy } from './watcher-strategy.js';

const BC = PUMPFUN_BONDING_CURVE_PROGRAM_ID;
const PS = PUMPFUN_PUMPSWAP_PROGRAM_ID;

const OTHER_PROGRAM = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WATCHED_MINT = PublicKey.fromBase58('11111111111111111111111111111112');
const WATCHED_USER = PublicKey.fromBase58('So11111111111111111111111111111111111111112');

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    signalId: 'test-sig-id',
    ts: 1_700_000_000_000,
    slot: 210_000_000,
    signature: 'sig-abc',
    programId: BC,
    kind: 'pumpfun.trade',
    decoded: {
      kind: 'pumpfun.trade',
      mint: WATCHED_MINT,
      user: WATCHED_USER,
      solAmount: 100_000_000n,
      tokenAmount: 5_000_000_000n,
      isBuy: true,
      timestamp: 1_700_000_100n,
    },
    raw: {} as unknown as Signal['raw'],
    ...overrides,
  };
}

const ctx = {} as unknown as StrategyContext;

describe('WatcherStrategy — filters', () => {
  it('filters on both pump.fun program IDs', () => {
    const s = new WatcherStrategy(undefined);
    expect(s.filters).toHaveLength(2);
    // Bonding curve filter matches bonding curve signals.
    expect(matches(s.filters[0]!, makeSignal({ programId: BC }))).toBe(true);
    // PumpSwap filter matches PumpSwap signals.
    expect(matches(s.filters[1]!, makeSignal({ programId: PS }))).toBe(true);
  });

  it('filters do not match non-pumpfun program ids', () => {
    const s = new WatcherStrategy(undefined);
    for (const f of s.filters) {
      expect(matches(f, makeSignal({ programId: OTHER_PROGRAM }))).toBe(false);
    }
  });

  it('filters do not constrain `kind` — any pumpfun.* variant is accepted', () => {
    const s = new WatcherStrategy(undefined);
    const kinds = [
      'pumpfun.create',
      'pumpfun.trade',
      'pumpfun.complete',
      'pumpfun.set_params',
      'pumpfun.creator_fee',
      'pumpfun.migrate',
      'unknown',
    ];
    for (const kind of kinds) {
      expect(matches(s.filters[0]!, makeSignal({ programId: BC, kind }))).toBe(true);
    }
  });
});

describe('WatcherStrategy — name', () => {
  it('has name pumpfun-watch', () => {
    const s = new WatcherStrategy(undefined);
    expect(s.name).toBe('pumpfun-watch');
  });
});

describe('WatcherStrategy — onSignal', () => {
  it('returns null for every signal (observer-only)', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    const r1 = await s.onSignal(makeSignal(), ctx);
    const r2 = await s.onSignal(makeSignal({ programId: PS, kind: 'pumpfun.swap' }), ctx);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it('emits one JSON line per signal with the expected shape', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    await s.onSignal(makeSignal(), ctx);
    expect(emit).toHaveBeenCalledOnce();
    const line = emit.mock.calls[0]![0] as string;
    const j = JSON.parse(line) as Record<string, unknown>;
    expect(j).toMatchObject({
      signalId: 'test-sig-id',
      ts: 1_700_000_000_000,
      slot: 210_000_000,
      signature: 'sig-abc',
      kind: 'pumpfun.trade',
      programId: BC.toBase58(),
    });
    expect(typeof j['decoded']).toBe('object');
  });

  it('serialises bigint fields as decimal strings', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    await s.onSignal(makeSignal(), ctx);
    const j = JSON.parse(emit.mock.calls[0]![0] as string) as { decoded: Record<string, unknown> };
    expect(j.decoded['solAmount']).toBe('100000000');
    expect(j.decoded['tokenAmount']).toBe('5000000000');
    expect(j.decoded['timestamp']).toBe('1700000100');
  });

  it('serialises PublicKey instances to base58 strings', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    await s.onSignal(makeSignal(), ctx);
    const j = JSON.parse(emit.mock.calls[0]![0] as string) as { decoded: Record<string, unknown> };
    expect(j.decoded['mint']).toBe(WATCHED_MINT.toBase58());
    expect(j.decoded['user']).toBe(WATCHED_USER.toBase58());
  });

  it('passes through string fields unchanged (fixture-sourced signals)', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    const sig = makeSignal({
      decoded: {
        kind: 'pumpfun.create',
        mint: WATCHED_MINT.toBase58(), // plain base58 string, as fixture emits
        name: 'Foo',
        symbol: 'FOO',
      },
    });
    await s.onSignal(sig, ctx);
    const j = JSON.parse(emit.mock.calls[0]![0] as string) as { decoded: Record<string, unknown> };
    expect(j.decoded['mint']).toBe(WATCHED_MINT.toBase58());
    expect(j.decoded['name']).toBe('Foo');
  });

  it('passes through boolean and number primitives', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    await s.onSignal(makeSignal(), ctx);
    const j = JSON.parse(emit.mock.calls[0]![0] as string) as { decoded: Record<string, unknown> };
    expect(j.decoded['isBuy']).toBe(true);
  });

  it('respects --max-events cap — stops emitting once reached', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(2, emit);
    await s.onSignal(makeSignal(), ctx);
    await s.onSignal(makeSignal(), ctx);
    await s.onSignal(makeSignal(), ctx); // over cap
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('max-events undefined means unlimited', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    for (let i = 0; i < 5; i++) await s.onSignal(makeSignal(), ctx);
    expect(emit).toHaveBeenCalledTimes(5);
  });

  it('handles nested arrays in decoded payload', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    await s.onSignal(
      makeSignal({
        decoded: {
          kind: 'pumpfun.trade',
          items: [1n, 2n, 3n],
        },
      }),
      ctx,
    );
    const j = JSON.parse(emit.mock.calls[0]![0] as string) as { decoded: Record<string, unknown> };
    expect(j.decoded['items']).toEqual(['1', '2', '3']);
  });

  it('handles null and undefined fields in decoded payload', async () => {
    const emit = vi.fn();
    const s = new WatcherStrategy(undefined, emit);
    await s.onSignal(
      makeSignal({
        decoded: {
          kind: 'pumpfun.unknown',
          maybeNull: null,
          maybeAbsent: undefined,
        },
      }),
      ctx,
    );
    const j = JSON.parse(emit.mock.calls[0]![0] as string) as { decoded: Record<string, unknown> };
    expect(j.decoded['maybeNull']).toBeNull();
    // `undefined` fields drop out of JSON.stringify — so the key is absent.
    expect('maybeAbsent' in j.decoded).toBe(false);
  });
});

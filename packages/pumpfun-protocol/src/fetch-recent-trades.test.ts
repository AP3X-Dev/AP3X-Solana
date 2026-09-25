import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMP_SCHEMA,
} from '@ap3x/pumpfun-events';

import {
  fetchRecentTrades,
  type UnifiedTrade,
} from './fetch-recent-trades.js';
import { deriveBondingCurvePda } from './curve/state.js';

const MINT_BASE58 = 'So11111111111111111111111111111111111111112';

// ---------------------------------------------------------------------------
// Discriminator hex strings copied verbatim from the event-decoder package.
// Keeping them inline (rather than importing) means this test catches a
// drift between the two modules — if the decoder renames or moves a
// discriminator constant we want the failure mode here to be loud.
// ---------------------------------------------------------------------------

// Real mainnet transactions captured by tests/helpers/capture/capture-pumpfun-per-variant.ts.
const FIXTURE = fileURLToPath(
  new URL('../../pumpfun-events/tests/fixtures/pumpfun-per-variant.jsonl.gz', import.meta.url),
);
const fixture = gunzipSync(readFileSync(FIXTURE))
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { variantHint: string; logs: string[] });
const logsFor = (variant: string): string[] => {
  const line = fixture.find((f) => f.variantHint === variant);
  if (!line) throw new Error(`fixture has no ${variant}`);
  return line.logs;
};

describe('fetchRecentTrades', () => {
  it('paginates via getSignaturesForAddress → getTransaction → decode', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const { address: curvePda } = deriveBondingCurvePda(mint);

    let call = 0;
    const responder = vi.fn(async (method: string, params: unknown) => {
      call += 1;
      if (method === 'getSignaturesForAddress') {
        const arr = params as unknown[];
        expect(arr[0]).toBe(curvePda.toBase58());
        // `before` not set → `getSignaturesForAddress` param should not include it.
        expect((arr[1] as Record<string, unknown>).before).toBeUndefined();
        return [
          { signature: 'sig1', slot: 100, blockTime: 1_700_000_000 },
          { signature: 'sig2', slot: 101, blockTime: null },
        ];
      }
      if (method === 'getTransaction') {
        const arr = params as unknown[];
        const sig = arr[0] as string;
        if (sig === 'sig1') {
          return { meta: { logMessages: logsFor('pumpfun.trade') } };
        }
        if (sig === 'sig2') {
          return { meta: { logMessages: logsFor('pumpswap.buy') } };
        }
      }
      throw new Error(`unexpected call ${call}: ${method}`);
    });
    const pool = { call: responder } as unknown as Parameters<
      typeof fetchRecentTrades
    >[0];

    const trades = await fetchRecentTrades(pool, mint, { limit: 10 });

    expect(trades).toHaveLength(2);

    const trade = trades[0]!;
    expect(trade.kind).toBe('pumpfun.trade');
    expect(trade.signature).toBe('sig1');
    expect(trade.slot).toBe(100);
    expect(trade.blockTime).toBe(1_700_000_000);
    // Discriminated-union narrowing for the trade-specific fields.
    if (trade.kind === 'pumpfun.trade') {
      expect(trade.solAmount).toBeGreaterThan(0n);
      expect(trade.tokenAmount).toBeGreaterThan(0n);
      expect(typeof trade.isBuy).toBe('boolean');
    }

    const swap = trades[1]!;
    expect(swap.kind).toBe('pumpswap.buy');
    expect(swap.signature).toBe('sig2');
    expect(swap.slot).toBe(101);
    // blockTime: null was mapped to 0 — a defined numeric value either way.
    expect(swap.blockTime).toBe(0);
    if (swap.kind === 'pumpswap.buy') {
      expect(swap.baseAmountOut).toBeGreaterThan(0n);
      expect(swap.quoteAmountIn).toBeGreaterThan(0n);
    }
  });

  it('passes `before` through to getSignaturesForAddress when untilSignature set', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === 'getSignaturesForAddress') {
        const arr = params as unknown[];
        expect((arr[1] as { before: string }).before).toBe('CURSOR_SIG');
        return [];
      }
      throw new Error('unexpected');
    });
    const pool = { call } as unknown as Parameters<typeof fetchRecentTrades>[0];
    const trades = await fetchRecentTrades(pool, mint, {
      limit: 5,
      untilSignature: 'CURSOR_SIG',
    });
    expect(trades).toEqual([]);
  });

  it('finds trades nested inside another program (aggregator CPI)', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const agg = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    // Re-nest the captured top-level trade one level deeper under an aggregator.
    const nested = [
      `Program ${agg} invoke [1]`,
      ...logsFor('pumpfun.trade').map((l) =>
        l.replace(/ invoke [(d+)]$/, (_, d: string) => ` invoke [${Number(d) + 1}]`),
      ),
      `Program ${agg} success`,
    ];
    const call = vi.fn(async (method: string) => {
      if (method === 'getSignaturesForAddress') return [{ signature: 'n', slot: 1, blockTime: 1 }];
      if (method === 'getTransaction') return { meta: { logMessages: nested } };
      throw new Error('unexpected');
    });
    const pool = { call } as unknown as Parameters<typeof fetchRecentTrades>[0];
    const trades = await fetchRecentTrades(pool, mint, { limit: 1 });
    expect(trades.map((t) => t.kind)).toContain('pumpfun.trade');
  });

  it('filters out non-trade events', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    // A decodable event that is not a trade (the IDL's ExtendAccountEvent).
    const ev = PUMP_SCHEMA.events.find((e) => e.name === 'ExtendAccountEvent')!;
    const disc = Buffer.from(ev.discriminator, 'hex');
    const body = Buffer.alloc(32 + 32 + 8 + 8 + 8);
    const pid = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
    const logs = [
      `Program ${pid} invoke [1]`,
      `Program data: ${Buffer.concat([disc, body]).toString('base64')}`,
      `Program ${pid} success`,
    ];

    const call = vi.fn(async (method: string) => {
      if (method === 'getSignaturesForAddress') {
        return [{ signature: 'sigX', slot: 1, blockTime: 1 }];
      }
      if (method === 'getTransaction') {
        return { meta: { logMessages: logs } };
      }
      throw new Error('unexpected');
    });
    const pool = { call } as unknown as Parameters<typeof fetchRecentTrades>[0];
    const trades = await fetchRecentTrades(pool, mint, { limit: 1 });
    expect(trades).toEqual([]);
  });

  it('returns empty when transaction has no log messages', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const call = vi.fn(async (method: string) => {
      if (method === 'getSignaturesForAddress') {
        return [{ signature: 's', slot: 1, blockTime: 1 }];
      }
      if (method === 'getTransaction') return { meta: { logMessages: [] } };
      throw new Error('unexpected');
    });
    const pool = { call } as unknown as Parameters<typeof fetchRecentTrades>[0];
    const trades: UnifiedTrade[] = await fetchRecentTrades(pool, mint, {
      limit: 1,
    });
    expect(trades).toEqual([]);
  });

  it('returns empty when getSignaturesForAddress yields null', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    const call = vi.fn(async () => null);
    const pool = { call } as unknown as Parameters<typeof fetchRecentTrades>[0];
    const trades = await fetchRecentTrades(pool, mint, { limit: 5 });
    expect(trades).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
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

const TRADE_DISC_HEX = 'bddb7fd34ee661ee';
const SWAP_DISC_HEX = '40c6cde8260871e2'; // PumpSwap SwapEvent (from pumpswap/discriminator.ts)

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * Encode a synthetic pump.fun TradeEvent payload matching the decoder's
 * field read order exactly:
 *   mint (32) | solAmount u64 | tokenAmount u64 | isBuy bool
 *   | user (32) | timestamp i64 | virtualSol u64 | virtualToken u64
 *   | realSol u64 | realToken u64
 * Prefixed with the 8-byte Anchor discriminator.
 */
function buildTradePayload(): Uint8Array {
  const body = new Uint8Array(32 + 8 + 8 + 1 + 32 + 8 + 8 + 8 + 8 + 8);
  const view = new DataView(body.buffer);
  // mint — 32 bytes of 0x11
  for (let i = 0; i < 32; i++) body[i] = 0x11;
  view.setBigUint64(32, 1_000_000n, true); // solAmount
  view.setBigUint64(40, 2_000_000n, true); // tokenAmount
  body[48] = 1; // isBuy
  // user — 32 bytes of 0x22
  for (let i = 49; i < 49 + 32; i++) body[i] = 0x22;
  view.setBigInt64(81, 1_700_000_000n, true); // timestamp
  view.setBigUint64(89, 30_000_000_000n, true); // virtualSol
  view.setBigUint64(97, 1_073_000_000_000_000n, true); // virtualToken
  view.setBigUint64(105, 5_000_000_000n, true); // realSol
  view.setBigUint64(113, 500_000_000_000_000n, true); // realToken

  const disc = hexToBytes(TRADE_DISC_HEX);
  const out = new Uint8Array(8 + body.length);
  out.set(disc, 0);
  out.set(body, 8);
  return out;
}

/**
 * Encode a synthetic PumpSwap SwapEvent payload matching the decoder's
 * field read order: pool, user, inputMint, outputMint (4x pubkey),
 * inputAmount, outputAmount, baseReserves, quoteReserves (4x u64),
 * timestamp (i64). 8-byte discriminator prefix.
 */
function buildSwapPayload(): Uint8Array {
  const body = new Uint8Array(32 * 4 + 8 * 4 + 8);
  const view = new DataView(body.buffer);
  // pool (0..32), user (32..64), inputMint (64..96), outputMint (96..128)
  for (let i = 0; i < 32; i++) body[i] = 0x33;
  for (let i = 32; i < 64; i++) body[i] = 0x44;
  for (let i = 64; i < 96; i++) body[i] = 0x55;
  for (let i = 96; i < 128; i++) body[i] = 0x66;
  view.setBigUint64(128, 111n, true); // inputAmount
  view.setBigUint64(136, 222n, true); // outputAmount
  view.setBigUint64(144, 333n, true); // baseReserves
  view.setBigUint64(152, 444n, true); // quoteReserves
  view.setBigInt64(160, 1_700_000_001n, true); // timestamp

  const disc = hexToBytes(SWAP_DISC_HEX);
  const out = new Uint8Array(8 + body.length);
  out.set(disc, 0);
  out.set(body, 8);
  return out;
}

/**
 * Build the fake `getTransaction` response's `meta.logMessages` array for a
 * single bonding-curve trade invocation. The sequence mirrors what the
 * validator emits: invoke, program data payload (base64), success.
 */
function tradeLogMessages(): string[] {
  const payload = buildTradePayload();
  const b64 = Buffer.from(payload).toString('base64');
  const pid = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
  return [
    `Program ${pid} invoke [1]`,
    `Program data: ${b64}`,
    `Program ${pid} success`,
  ];
}

function swapLogMessages(): string[] {
  const payload = buildSwapPayload();
  const b64 = Buffer.from(payload).toString('base64');
  const pid = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();
  return [
    `Program ${pid} invoke [1]`,
    `Program data: ${b64}`,
    `Program ${pid} success`,
  ];
}

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
          return { meta: { logMessages: tradeLogMessages() } };
        }
        if (sig === 'sig2') {
          return { meta: { logMessages: swapLogMessages() } };
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
      expect(trade.solAmount).toBe(1_000_000n);
      expect(trade.tokenAmount).toBe(2_000_000n);
      expect(trade.isBuy).toBe(true);
    }

    const swap = trades[1]!;
    expect(swap.kind).toBe('pumpfun.swap');
    expect(swap.signature).toBe('sig2');
    expect(swap.slot).toBe(101);
    // blockTime: null was mapped to 0 — a defined numeric value either way.
    expect(swap.blockTime).toBe(0);
    if (swap.kind === 'pumpfun.swap') {
      expect(swap.inputAmount).toBe(111n);
      expect(swap.outputAmount).toBe(222n);
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

  it('filters out non-trade events (e.g. CreatorFee, AddLiquidity)', async () => {
    const mint = PublicKey.fromBase58(MINT_BASE58);
    // A valid discriminator for CreatorFee — mapped to `pumpfun.creator_fee`
    // which is NOT a trade kind, so should be silently skipped.
    const creatorFeeDisc = hexToBytes('33e685a4017f83ad');
    const body = new Uint8Array(32 + 32 + 8 + 8);
    for (let i = 0; i < 32; i++) body[i] = 0x77; // mint
    for (let i = 32; i < 64; i++) body[i] = 0x88; // creator
    new DataView(body.buffer).setBigUint64(64, 42n, true); // solAmount
    new DataView(body.buffer).setBigInt64(72, 1_700_000_000n, true); // timestamp
    const payload = new Uint8Array(8 + body.length);
    payload.set(creatorFeeDisc, 0);
    payload.set(body, 8);
    const b64 = Buffer.from(payload).toString('base64');

    const pid = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
    const logs = [
      `Program ${pid} invoke [1]`,
      `Program data: ${b64}`,
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

import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';

import { holders, type HolderSummary } from './holders.js';

// ---------------------------------------------------------------------------
// Minimal mock pool — captures calls + returns a preset response per method.
// `RpcPool` is a big class; our helpers only touch `.call`, so a duck-typed
// stand-in is fine and avoids wiring connectivity fakes through every test.
// ---------------------------------------------------------------------------

type Responder = (method: string, params: unknown) => unknown;

function mockPool(responder: Responder): {
  call: (method: string, params: unknown) => Promise<unknown>;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return responder(method, params);
    }),
  };
}

const MINT = PublicKey.fromBase58('So11111111111111111111111111111111111111112');

// Three synthetic token account addresses — deterministic bytes so the base58
// representations stay stable across CI runs.
function synthAddr(seed: number): string {
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) buf[i] = (seed * 13 + i) & 0xff;
  return PublicKey.fromBytes(buf).toBase58();
}
const HOLDER_A = synthAddr(1);
const HOLDER_B = synthAddr(2);
const HOLDER_C = synthAddr(3);

describe('holders (limit <= 20 path)', () => {
  it('maps getTokenLargestAccounts entries into HolderSummary records', async () => {
    const pool = mockPool(() => ({
      context: { slot: 0 },
      value: [
        { address: HOLDER_A, amount: '500000000', decimals: 6 },
        { address: HOLDER_B, amount: '300000000', decimals: 6 },
        { address: HOLDER_C, amount: '200000000', decimals: 6 },
      ],
    }));

    const totalSupply = 1_000_000_000n;
    const result = await holders(
      pool as unknown as Parameters<typeof holders>[0],
      MINT,
      10,
      totalSupply,
    );

    expect(result).toHaveLength(3);
    expect(result[0]!.balance).toBe(500_000_000n);
    expect(result[0]!.pctOfSupply).toBeCloseTo(0.5, 10);
    expect(result[1]!.pctOfSupply).toBeCloseTo(0.3, 10);
    expect(result[2]!.pctOfSupply).toBeCloseTo(0.2, 10);
    expect(result[0]!.address.toBase58()).toBe(HOLDER_A);
    expect(pool.calls[0]!.method).toBe('getTokenLargestAccounts');
  });

  it('respects `limit` by slicing the response (<= 20 path)', async () => {
    const pool = mockPool(() => ({
      context: { slot: 0 },
      value: [
        { address: HOLDER_A, amount: '10', decimals: 0 },
        { address: HOLDER_B, amount: '9', decimals: 0 },
        { address: HOLDER_C, amount: '8', decimals: 0 },
      ],
    }));
    const result = await holders(
      pool as unknown as Parameters<typeof holders>[0],
      MINT,
      2,
      100n,
    );
    expect(result).toHaveLength(2);
    expect(result.map((r: HolderSummary) => r.address.toBase58())).toEqual([
      HOLDER_A,
      HOLDER_B,
    ]);
  });

  it('returns pctOfSupply = 0 when totalSupply is 0n (no division by zero)', async () => {
    const pool = mockPool(() => ({
      context: { slot: 0 },
      value: [{ address: HOLDER_A, amount: '42', decimals: 0 }],
    }));
    const result = await holders(
      pool as unknown as Parameters<typeof holders>[0],
      MINT,
      5,
      0n,
    );
    expect(result[0]!.pctOfSupply).toBe(0);
    expect(result[0]!.balance).toBe(42n);
    // Explicit NaN/Infinity guard — the whole point of the 0n branch.
    expect(Number.isFinite(result[0]!.pctOfSupply)).toBe(true);
  });
});

describe('holders (limit > 20 path)', () => {
  // Build a minimal base64-encoded SPL v1 token account (165 bytes) with a
  // given amount at offset 64..72. Mint + owner bytes are arbitrary — the
  // decoder only looks up `amount`, `state`, etc. by offset.
  function encodeTokenAccount(amount: bigint): string {
    const buf = new Uint8Array(165);
    const view = new DataView(buf.buffer);
    // mint: 32 bytes of 0x11 (arbitrary)
    for (let i = 0; i < 32; i++) buf[i] = 0x11;
    // owner: 32 bytes of 0x22
    for (let i = 32; i < 64; i++) buf[i] = 0x22;
    // amount: u64 LE at offset 64
    view.setBigUint64(64, amount, true);
    // delegate COption tag (4 bytes) — 0 (None)
    // state at offset 108 — 1 (Initialized) is required
    buf[108] = 1;
    // Remaining bytes are zero-initialised; that's fine for a "None" COption
    // world + non-native + delegated_amount = 0 + no close authority.
    return Buffer.from(buf).toString('base64');
  }

  function synthHolding(addr: string, amount: bigint) {
    return {
      pubkey: addr,
      account: {
        data: [encodeTokenAccount(amount), 'base64'] as [string, string],
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      },
    };
  }

  it('sorts by balance desc + slices to limit when limit > 20', async () => {
    // 25 holders so we exercise the > 20 branch and still have room to sort.
    const holdings = [
      synthHolding(HOLDER_A, 300n),
      synthHolding(HOLDER_B, 500n),
      synthHolding(HOLDER_C, 100n),
      ...Array.from({ length: 22 }, (_, i) =>
        synthHolding(synthAddr(10 + i), BigInt(50 - i)),
      ),
    ];

    const pool = mockPool((method) => {
      if (method === 'getProgramAccounts') return holdings;
      throw new Error(`unexpected call: ${method}`);
    });

    const result = await holders(
      pool as unknown as Parameters<typeof holders>[0],
      MINT,
      25,
      10_000n,
    );

    expect(result).toHaveLength(25);
    // Top 3 preserved in balance-desc order.
    expect(result[0]!.balance).toBe(500n);
    expect(result[1]!.balance).toBe(300n);
    expect(result[2]!.balance).toBe(100n);
    // pctOfSupply reflects balance/10000.
    expect(result[0]!.pctOfSupply).toBeCloseTo(0.05, 10);
    // Sort is stable: balances are monotonically non-increasing.
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.balance <= result[i - 1]!.balance).toBe(true);
    }
  });
});

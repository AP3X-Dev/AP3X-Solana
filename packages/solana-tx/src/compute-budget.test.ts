import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  metrics,
  PublicKey,
  type MetricEvent,
} from '@ap3x/solana-core';

import {
  simulateAndBudget,
  FALLBACK_UNITS_CONSUMED,
  FALLBACK_UNITS_LIMIT,
  BUDGET_HEADROOM,
  type RpcPoolLike,
} from './compute-budget';

// -------------------------------------------------------------------------
// Fakes
// -------------------------------------------------------------------------

function makePool(
  impl: (method: string, params: unknown) => unknown,
): RpcPoolLike & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      return impl(method, params);
    },
  };
}

const DUMMY_PAYER = PublicKey.fromBase58(
  'So11111111111111111111111111111111111111112',
);
const DUMMY_TX_B64 = Buffer.from([1, 2, 3, 4, 5]).toString('base64');

// -------------------------------------------------------------------------
// Test scaffolding — capture metric events
// -------------------------------------------------------------------------

let captured: MetricEvent[];
let listener: (ev: MetricEvent) => void;

beforeEach(() => {
  captured = [];
  listener = (ev) => captured.push(ev);
  metrics.on('metric', listener);
});

afterEach(() => {
  metrics.off('metric', listener);
});

// -------------------------------------------------------------------------
// Success path
// -------------------------------------------------------------------------

describe('simulateAndBudget — success', () => {
  it('returns unitsConsumed + ceil(unitsConsumed * 1.15) as unitsLimit', async () => {
    const pool = makePool(() => ({ value: { unitsConsumed: 50_000, err: null } }));
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsConsumed).toBe(50_000);
    expect(result.unitsLimit).toBe(57_500);
  });

  it('calls simulateTransaction with base64 encoding + sigVerify=false + replaceRecentBlockhash', async () => {
    const pool = makePool(() => ({ value: { unitsConsumed: 1000 } }));
    await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.method).toBe('simulateTransaction');
    const params = pool.calls[0]!.params as unknown[];
    expect(params[0]).toBe(DUMMY_TX_B64);
    expect(params[1]).toEqual({
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
  });

  it('does NOT emit a fallback metric on success', async () => {
    const pool = makePool(() => ({ value: { unitsConsumed: 123 } }));
    await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(captured.filter((e) => e.op === 'compute-budget-fallback')).toHaveLength(0);
  });

  it('applies the exact 15% headroom constant', async () => {
    const pool = makePool(() => ({ value: { unitsConsumed: 10_000 } }));
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsLimit).toBe(Math.ceil(10_000 * BUDGET_HEADROOM));
  });

  it('rounds unitsLimit up via Math.ceil (non-integer headroom product)', async () => {
    // 123 * 1.15 = 141.45 → ceil → 142
    const pool = makePool(() => ({ value: { unitsConsumed: 123 } }));
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsLimit).toBe(142);
  });

  it('clamps negative unitsConsumed to 0 (defensive)', async () => {
    const pool = makePool(() => ({ value: { unitsConsumed: -100 } }));
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsConsumed).toBe(0);
    expect(result.unitsLimit).toBe(0);
  });
});

// -------------------------------------------------------------------------
// Fallback — simulation error
// -------------------------------------------------------------------------

describe('simulateAndBudget — simulation error', () => {
  it('falls back when value.err is non-null', async () => {
    const pool = makePool(() => ({
      value: { err: { InstructionError: [0, 'Custom'] }, unitsConsumed: 500 },
    }));
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsConsumed).toBe(FALLBACK_UNITS_CONSUMED);
    expect(result.unitsLimit).toBe(FALLBACK_UNITS_LIMIT);
  });

  it('emits a compute-budget-fallback metric with the err serialized', async () => {
    const pool = makePool(() => ({
      value: { err: { InstructionError: [0, 'Custom'] } },
    }));
    await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    const events = captured.filter((e) => e.op === 'compute-budget-fallback');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.package).toBe('@ap3x/solana-tx');
    expect(ev.meta).toBeDefined();
    expect(ev.meta!.reason).toMatch(/simulation error/);
    expect(ev.meta!.note).toMatch(/PRP-01 stub/);
    expect(typeof ev.ts).toBe('number');
  });

  it('falls back when response is missing value', async () => {
    const pool = makePool(() => ({ unexpected: true }));
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsConsumed).toBe(FALLBACK_UNITS_CONSUMED);
    expect(result.unitsLimit).toBe(FALLBACK_UNITS_LIMIT);
    const events = captured.filter((e) => e.op === 'compute-budget-fallback');
    expect(events).toHaveLength(1);
  });

  it('uses fallback when unitsConsumed is missing but no err', async () => {
    // No err, no unitsConsumed → still succeeds, but uses FALLBACK as the floor.
    const pool = makePool(() => ({ value: { err: null } }));
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsConsumed).toBe(FALLBACK_UNITS_CONSUMED);
    expect(result.unitsLimit).toBe(Math.ceil(FALLBACK_UNITS_CONSUMED * BUDGET_HEADROOM));
  });
});

// -------------------------------------------------------------------------
// Fallback — thrown exception
// -------------------------------------------------------------------------

describe('simulateAndBudget — exception', () => {
  it('falls back when the pool throws', async () => {
    const pool: RpcPoolLike = {
      async call() {
        throw new Error('network down');
      },
    };
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsConsumed).toBe(FALLBACK_UNITS_CONSUMED);
    expect(result.unitsLimit).toBe(FALLBACK_UNITS_LIMIT);
  });

  it('emits a compute-budget-fallback metric with the error message', async () => {
    const pool: RpcPoolLike = {
      async call() {
        throw new Error('network down');
      },
    };
    await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    const events = captured.filter((e) => e.op === 'compute-budget-fallback');
    expect(events).toHaveLength(1);
    expect(events[0]!.meta!.reason).toBe('network down');
  });

  it('stringifies non-Error throws safely', async () => {
    const pool: RpcPoolLike = {
      async call() {
        // eslint-disable-next-line no-throw-literal
        throw { code: 'BOOM', nested: 42 };
      },
    };
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsConsumed).toBe(FALLBACK_UNITS_CONSUMED);
    const events = captured.filter((e) => e.op === 'compute-budget-fallback');
    expect(events).toHaveLength(1);
    expect(events[0]!.meta!.reason).toMatch(/BOOM/);
  });

  it('handles cyclic error objects without crashing', async () => {
    const cyclic: Record<string, unknown> = { name: 'weird' };
    cyclic['self'] = cyclic;
    const pool: RpcPoolLike = {
      async call() {
        // eslint-disable-next-line no-throw-literal
        throw cyclic;
      },
    };
    const result = await simulateAndBudget(pool, DUMMY_TX_B64, DUMMY_PAYER);
    expect(result.unitsConsumed).toBe(FALLBACK_UNITS_CONSUMED);
    const events = captured.filter((e) => e.op === 'compute-budget-fallback');
    expect(events).toHaveLength(1);
    // reason is something — we just can't guarantee it's JSON
    expect(typeof events[0]!.meta!.reason).toBe('string');
  });
});

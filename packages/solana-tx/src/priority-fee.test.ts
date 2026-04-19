import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';

import type {
  GeyserClient,
  GeyserUpdate,
  SubscribeRequest,
  Subscription,
} from '@ap3x/solana-connectivity';

import {
  PriorityFeeEstimator,
  WARMUP_DEFAULTS,
  SIGNATURE_FEE_LAMPORTS,
  quantile,
} from './priority-fee';

// -------------------------------------------------------------------------
// Fake Geyser scaffolding
// -------------------------------------------------------------------------

/**
 * Minimal Subscription stand-in — emits on close so tests can verify clean
 * shutdown, and tracks invocation so we can assert idempotency.
 */
class FakeSubscription extends EventEmitter implements Subscription {
  closeCalls = 0;
  close(): void {
    this.closeCalls += 1;
  }
  loadedCheckpoint(): null {
    return null;
  }
}

/**
 * Fake GeyserClient whose `subscribe` captures the handler so tests can
 * feed it updates directly. Satisfies the shape of the real `GeyserClient`
 * without opening a real gRPC channel.
 */
class FakeGeyser {
  lastRequest: SubscribeRequest | undefined;
  handler:
    | ((update: GeyserUpdate) => void | Promise<void>)
    | undefined;
  subscription = new FakeSubscription();

  subscribe(
    req: SubscribeRequest,
    handler: (update: GeyserUpdate) => void | Promise<void>,
  ): Subscription {
    this.lastRequest = req;
    this.handler = handler;
    return this.subscription;
  }
}

function makeEstimator(overrides: Partial<{
  windowSlots: number;
  warmupSlots: number;
  onSlot: (slot: number) => void;
}> = {}): { est: PriorityFeeEstimator; geyser: FakeGeyser } {
  const geyser = new FakeGeyser();
  const est = new PriorityFeeEstimator({
    geyser: geyser as unknown as GeyserClient,
    ...overrides,
  });
  est.start();
  return { est, geyser };
}

// Builds a transaction update with a known fee and unit count.
function txUpdate(
  slot: number,
  feeLamports: number,
  unitsConsumed: number,
  signers = 1,
): GeyserUpdate {
  return {
    transaction: {
      slot,
      signatures: Array(signers).fill(new Uint8Array(64)),
      meta: {
        fee: feeLamports,
        computeUnitsConsumed: unitsConsumed,
      },
      transaction: {
        message: {
          header: { numRequiredSignatures: signers },
        },
      },
    },
  } as unknown as GeyserUpdate;
}

function slotUpdate(slot: number): GeyserUpdate {
  return { slot: { slot } } as unknown as GeyserUpdate;
}

// -------------------------------------------------------------------------
// Quantile helper
// -------------------------------------------------------------------------

describe('quantile', () => {
  it('returns the middle of an odd-length ascending sample', () => {
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
  });

  it('linear-interpolates between adjacent samples', () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
  });

  it('clamps to the min at p <= 0 and max at p >= 1', () => {
    expect(quantile([5, 10, 15], 0)).toBe(5);
    expect(quantile([5, 10, 15], 1)).toBe(15);
    expect(quantile([5, 10, 15], -0.1)).toBe(5);
    expect(quantile([5, 10, 15], 1.1)).toBe(15);
  });

  it('approximates NumPy-linear p90 on [1..100]', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    const p90 = quantile(arr, 0.9);
    // Linear formula: index = 0.9 * 99 = 89.1 → between arr[89]=90 and arr[90]=91
    expect(p90).toBeCloseTo(90.1, 5);
  });

  it('throws on an empty sample set', () => {
    expect(() => quantile([], 0.5)).toThrow(/empty sample/);
  });
});

// -------------------------------------------------------------------------
// Warmup behaviour
// -------------------------------------------------------------------------

describe('PriorityFeeEstimator — warmup', () => {
  it('returns conservative defaults before warmup completes', () => {
    const { est } = makeEstimator({ warmupSlots: 30 });
    expect(est.tier('low')).toBe(WARMUP_DEFAULTS.low);
    expect(est.tier('med')).toBe(WARMUP_DEFAULTS.med);
    expect(est.tier('high')).toBe(WARMUP_DEFAULTS.high);
    expect(est.tier('turbo')).toBe(WARMUP_DEFAULTS.turbo);
  });

  it('stays in warmup until `warmupSlots` distinct slots are seen', () => {
    const { est, geyser } = makeEstimator({ warmupSlots: 5 });
    expect(est.isWarmup()).toBe(true);
    for (let s = 1; s <= 4; s++) {
      geyser.handler!(slotUpdate(s));
    }
    expect(est.isWarmup()).toBe(true);
    // 5th distinct slot → transition
    geyser.handler!(slotUpdate(5));
    expect(est.isWarmup()).toBe(false);
  });

  it('transitions out of warmup and begins percentile-driven answers', () => {
    const { est, geyser } = makeEstimator({ warmupSlots: 2, windowSlots: 10 });
    // Warmup: feed 2 distinct slots worth of samples
    for (let s = 1; s <= 2; s++) {
      geyser.handler!(txUpdate(s, 5000 + 1000, 1000));
    }
    // Post-warmup: percentile takes over. Fee = base+1000 lamports over
    // 1000 CUs → priority = 1000 lamports * 1e6 / 1000 = 1e6 microL per CU.
    expect(est.tier('low')).toBe(1_000_000);
  });
});

// -------------------------------------------------------------------------
// Percentile correctness on a known distribution
// -------------------------------------------------------------------------

describe('PriorityFeeEstimator — percentile tiers', () => {
  it('returns p50/p75/p90 over a synthetic 1000-sample stream', () => {
    const { est } = makeEstimator({ warmupSlots: 1, windowSlots: 1000 });
    // Inject 1000 samples: microLamportsPerCu = i for i in 1..1000
    for (let i = 1; i <= 1000; i++) {
      est._ingestSample(Math.floor(i / 5) + 1, i);
    }
    // p50 of 1..1000 linear = 500.5
    expect(est.tier('low')).toBeCloseTo(500.5, 3);
    expect(est.tier('med')).toBeCloseTo(750.25, 3);
    expect(est.tier('high')).toBeCloseTo(900.1, 3);
    // turbo = p99 * 1.1
    expect(est.tier('turbo')).toBeCloseTo(990.01 * 1.1, 3);
  });

  it('is monotonic across tiers when samples form a non-degenerate distribution', () => {
    const { est } = makeEstimator({ warmupSlots: 1, windowSlots: 500 });
    for (let i = 1; i <= 500; i++) {
      est._ingestSample(Math.floor(i / 5) + 1, i * 2);
    }
    const low = est.tier('low');
    const med = est.tier('med');
    const high = est.tier('high');
    const turbo = est.tier('turbo');
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
    expect(high).toBeLessThan(turbo);
  });
});

// -------------------------------------------------------------------------
// Window pruning
// -------------------------------------------------------------------------

describe('PriorityFeeEstimator — windowing', () => {
  it('drops samples outside the active window', () => {
    const { est } = makeEstimator({ warmupSlots: 1, windowSlots: 10 });
    for (let s = 1; s <= 20; s++) {
      est._ingestSample(s, 42);
    }
    // Only slots [11..20] should survive — 10 samples.
    expect(est.sampleCount()).toBe(10);
  });

  it('keeps samples from the same slot as the latest', () => {
    const { est } = makeEstimator({ warmupSlots: 1, windowSlots: 5 });
    est._ingestSample(100, 1);
    est._ingestSample(100, 2);
    est._ingestSample(100, 3);
    expect(est.sampleCount()).toBe(3);
  });

  it('advances lastSlot as samples arrive', () => {
    const { est } = makeEstimator();
    expect(est.lastSlot()).toBe(-1);
    est._ingestSample(42, 10);
    expect(est.lastSlot()).toBe(42);
    est._ingestSample(50, 10);
    expect(est.lastSlot()).toBe(50);
    // A late-arriving older slot should not walk lastSlot backwards.
    est._ingestSample(45, 10);
    expect(est.lastSlot()).toBe(50);
  });
});

// -------------------------------------------------------------------------
// End-to-end — Geyser update stream
// -------------------------------------------------------------------------

describe('PriorityFeeEstimator — Geyser stream', () => {
  it('subscribes with the required vote=false/failed=false filter', () => {
    const { geyser } = makeEstimator();
    expect(geyser.lastRequest).toBeDefined();
    expect(geyser.lastRequest!.transactions).toBeDefined();
    const filter = Object.values(geyser.lastRequest!.transactions!)[0]!;
    expect(filter.vote).toBe(false);
    expect(filter.failed).toBe(false);
  });

  it('computes microLamports/CU from meta.fee + unitsConsumed + signer count', () => {
    const { est, geyser } = makeEstimator({ warmupSlots: 1, windowSlots: 50 });
    // fee = 2 signers * 5000 (=10000 base) + 500 priority lamports
    // units = 1000
    // expected microLamports/CU = 500 * 1e6 / 1000 = 500_000
    geyser.handler!(txUpdate(100, 10_500, 1000, 2));
    geyser.handler!(txUpdate(100, 10_500, 1000, 2));
    // Warmup ≤ 1 so tier returns a percentile. All samples equal → p50 = p99 = 500_000.
    expect(est.tier('low')).toBe(500_000);
    expect(est.tier('med')).toBe(500_000);
    expect(est.tier('high')).toBe(500_000);
    // turbo applies the 10% topup
    expect(est.tier('turbo')).toBeCloseTo(500_000 * 1.1, 3);
  });

  it('ignores txs with negative priority fees (fee below base signature cost)', () => {
    const { est, geyser } = makeEstimator({ warmupSlots: 1, windowSlots: 50 });
    // Feed one good sample first to leave warmup.
    est._ingestSample(100, 10_000);
    // Bad: fee = 1000 (< 5000 base), skipped.
    geyser.handler!(txUpdate(100, 1000, 1000, 1));
    // Sample count unchanged (still 1).
    expect(est.sampleCount()).toBe(1);
  });

  it('ignores txs with unitsConsumed=0 to avoid divide-by-zero', () => {
    const { est, geyser } = makeEstimator({ warmupSlots: 1, windowSlots: 50 });
    est._ingestSample(100, 10_000);
    geyser.handler!(txUpdate(100, 10_000, 0, 1));
    expect(est.sampleCount()).toBe(1);
  });

  it('skips updates with missing meta or err set', () => {
    const { est, geyser } = makeEstimator({ warmupSlots: 1, windowSlots: 50 });
    est._ingestSample(100, 10_000);
    // No meta
    geyser.handler!({ transaction: { slot: 100 } } as unknown as GeyserUpdate);
    // With err
    geyser.handler!({
      transaction: {
        slot: 100,
        meta: { err: 'InstructionError', fee: 10_000, computeUnitsConsumed: 1000 },
      },
    } as unknown as GeyserUpdate);
    expect(est.sampleCount()).toBe(1);
  });

  it('records a slot-only update without creating a fee sample', () => {
    const { est, geyser } = makeEstimator({ warmupSlots: 50 });
    geyser.handler!(slotUpdate(42));
    geyser.handler!(slotUpdate(43));
    geyser.handler!(slotUpdate(44));
    expect(est.sampleCount()).toBe(0);
    expect(est.lastSlot()).toBe(44);
  });

  it('falls back to outer signature length when header is absent', () => {
    const { est, geyser } = makeEstimator({ warmupSlots: 1, windowSlots: 50 });
    est._ingestSample(100, 0); // Force warmup exit
    // Build tx without header but with outer signatures array of 3
    const update = {
      transaction: {
        slot: 101,
        signatures: [new Uint8Array(64), new Uint8Array(64), new Uint8Array(64)],
        meta: { fee: 3 * SIGNATURE_FEE_LAMPORTS + 300, computeUnitsConsumed: 1000 },
      },
    } as unknown as GeyserUpdate;
    geyser.handler!(update);
    // Priority = 300, microL/CU = 300 * 1e6 / 1000 = 300_000
    // After warmup exit ingestion of that one real sample:
    expect(est.sampleCount()).toBe(2);
  });
});

// -------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------

describe('PriorityFeeEstimator — lifecycle', () => {
  it('close() unsubscribes from Geyser', () => {
    const { est, geyser } = makeEstimator();
    est.close();
    expect(geyser.subscription.closeCalls).toBe(1);
  });

  it('close() is idempotent', () => {
    const { est, geyser } = makeEstimator();
    est.close();
    est.close();
    est.close();
    expect(geyser.subscription.closeCalls).toBe(1);
  });

  it('start() after close() is a no-op', () => {
    const { est, geyser } = makeEstimator();
    est.close();
    // Replace the handler then call start again
    geyser.handler = undefined;
    est.start();
    // Still no handler set; the fake only captures handler on the next
    // subscribe() call — which start() should skip when closed.
    expect(geyser.handler).toBeUndefined();
  });

  it('start() is idempotent — second call does not double-subscribe', () => {
    const geyser = new FakeGeyser();
    const est = new PriorityFeeEstimator({ geyser: geyser as unknown as GeyserClient });
    let subscribeCalls = 0;
    const originalSubscribe = geyser.subscribe.bind(geyser);
    geyser.subscribe = (req, handler) => {
      subscribeCalls += 1;
      return originalSubscribe(req, handler);
    };
    est.start();
    est.start();
    est.start();
    expect(subscribeCalls).toBe(1);
  });

  it('close() tolerates the subscription throwing', () => {
    const geyser = new FakeGeyser();
    geyser.subscription.close = () => {
      throw new Error('boom');
    };
    const est = new PriorityFeeEstimator({ geyser: geyser as unknown as GeyserClient });
    est.start();
    expect(() => est.close()).not.toThrow();
  });
});

// -------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------

describe('PriorityFeeEstimator — construction', () => {
  it('throws when geyser is missing', () => {
    expect(
      () =>
        new PriorityFeeEstimator({
          geyser: undefined as unknown as GeyserClient,
        }),
    ).toThrow(/geyser is required/);
  });

  it('throws when windowSlots < 1', () => {
    const g = new FakeGeyser();
    expect(
      () =>
        new PriorityFeeEstimator({
          geyser: g as unknown as GeyserClient,
          windowSlots: 0,
        }),
    ).toThrow(/windowSlots/);
  });

  it('throws when warmupSlots < 0', () => {
    const g = new FakeGeyser();
    expect(
      () =>
        new PriorityFeeEstimator({
          geyser: g as unknown as GeyserClient,
          warmupSlots: -1,
        }),
    ).toThrow(/warmupSlots/);
  });

  it('invokes onSlot for each new distinct slot', () => {
    const seen: number[] = [];
    const { geyser } = makeEstimator({ onSlot: (s) => seen.push(s) });
    geyser.handler!(slotUpdate(1));
    geyser.handler!(slotUpdate(1)); // duplicate — ignored
    geyser.handler!(slotUpdate(2));
    expect(seen).toEqual([1, 2]);
  });

  it('tolerates throwing onSlot observers', () => {
    const { est, geyser } = makeEstimator({
      onSlot: () => {
        throw new Error('observer boom');
      },
    });
    expect(() => geyser.handler!(slotUpdate(10))).not.toThrow();
    expect(est.lastSlot()).toBe(10);
  });
});

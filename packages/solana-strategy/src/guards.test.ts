import { describe, it, expect } from 'vitest';
import { GuardTracker } from './guards.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a controllable clock — returns a function whose internal timestamp
 *  can be advanced by calling advance(ms). */
function makeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let ts = startMs;
  return {
    now: () => ts,
    advance: (ms) => { ts += ms; },
  };
}

/** Fixed-timestamp UTC midnight for a given date string, e.g. "2025-01-01". */
function utcMidnight(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

describe('GuardTracker.recordDecision', () => {
  it('1. under threshold: N ≤ 60 calls in 1 minute all return null', () => {
    const clk = makeClock(1_000_000);
    const tracker = new GuardTracker({}, clk.now);
    for (let i = 0; i < 60; i++) {
      expect(tracker.recordDecision()).toBeNull();
    }
  });

  it('2. over threshold: 61st call in 1 minute returns { guard: "maxDecisionsPerMin", value: 61 }', () => {
    const clk = makeClock(1_000_000);
    const tracker = new GuardTracker({}, clk.now);
    for (let i = 0; i < 60; i++) {
      tracker.recordDecision();
    }
    const trip = tracker.recordDecision();
    expect(trip).toEqual({ guard: 'maxDecisionsPerMin', value: 61 });
  });

  it('3. window eviction: 60 decisions at t=0, advance >60s, next call returns null', () => {
    const clk = makeClock(1_000_000);
    const tracker = new GuardTracker({}, clk.now);
    for (let i = 0; i < 60; i++) {
      tracker.recordDecision();
    }
    clk.advance(60_001); // evict all old entries
    expect(tracker.recordDecision()).toBeNull();
  });

  it('4. custom threshold: maxDecisionsPerMin:2 — 3rd in 60s trips', () => {
    const clk = makeClock(1_000_000);
    const tracker = new GuardTracker({ maxDecisionsPerMin: 2 }, clk.now);
    expect(tracker.recordDecision()).toBeNull();
    expect(tracker.recordDecision()).toBeNull();
    const trip = tracker.recordDecision();
    expect(trip).toEqual({ guard: 'maxDecisionsPerMin', value: 3 });
  });
});

// ---------------------------------------------------------------------------
// recordError
// ---------------------------------------------------------------------------

describe('GuardTracker.recordError', () => {
  it('5. over default threshold: 6th error in 60s returns { guard: "errorThreshold", value: 6 }', () => {
    const clk = makeClock(1_000_000);
    const tracker = new GuardTracker({}, clk.now);
    for (let i = 0; i < 5; i++) {
      expect(tracker.recordError()).toBeNull();
    }
    const trip = tracker.recordError();
    expect(trip).toEqual({ guard: 'errorThreshold', value: 6 });
  });

  it('6a. custom window: 4 errors in <1s trips', () => {
    const clk = makeClock(1_000_000);
    const tracker = new GuardTracker({ errorThreshold: { errors: 3, windowMs: 1_000 } }, clk.now);
    tracker.recordError();
    tracker.recordError();
    tracker.recordError();
    const trip = tracker.recordError();
    expect(trip).toEqual({ guard: 'errorThreshold', value: 4 });
  });

  it('6b. custom window: errors spread across >1s do not trip', () => {
    const clk = makeClock(1_000_000);
    const tracker = new GuardTracker({ errorThreshold: { errors: 3, windowMs: 1_000 } }, clk.now);
    tracker.recordError(); // t=0
    clk.advance(400);
    tracker.recordError(); // t=400
    clk.advance(400);
    tracker.recordError(); // t=800 — 3 errors in window
    clk.advance(400);     // t=1200 — first error (t=0) now evicted (1200-0 >= 1000)
    expect(tracker.recordError()).toBeNull(); // only 3 remain in window
  });
});

// ---------------------------------------------------------------------------
// recordRealized
// ---------------------------------------------------------------------------

describe('GuardTracker.recordRealized', () => {
  it('7. under threshold: cumulative -99 < limit 100 → null on both records', () => {
    const clk = makeClock(utcMidnight('2025-01-01') + 1_000);
    const tracker = new GuardTracker({ maxLossPerDayLamports: 100n }, clk.now);
    expect(tracker.recordRealized(-50n)).toBeNull();
    expect(tracker.recordRealized(-49n)).toBeNull(); // cumulative -99, still > -100
  });

  it('8. over threshold: -101n trips with value: -101n', () => {
    const clk = makeClock(utcMidnight('2025-01-01') + 1_000);
    const tracker = new GuardTracker({ maxLossPerDayLamports: 100n }, clk.now);
    const trip = tracker.recordRealized(-101n);
    expect(trip).toEqual({ guard: 'maxLossPerDayLamports', value: -101n });
  });

  it('9. day rollover: tripped on day 1, reset on day 2 — -50n on day 2 returns null', () => {
    // Day 1: record -200n which would trip (limit 100)
    const day1Start = utcMidnight('2025-01-01');
    const day2Start = utcMidnight('2025-01-02');
    const clk = makeClock(day1Start + 1_000);
    const tracker = new GuardTracker({ maxLossPerDayLamports: 100n }, clk.now);

    // Day 1 — trips
    const tripDay1 = tracker.recordRealized(-200n);
    expect(tripDay1).toEqual({ guard: 'maxLossPerDayLamports', value: -200n });

    // Advance to day 2
    clk.advance(day2Start - day1Start); // now at day2Start + 1000

    // Day 2 — small loss, should not trip after rollover
    expect(tracker.recordRealized(-50n)).toBeNull();
  });

  it('10. profits offset losses: +100n then -100n → cumulative 0 → no trip', () => {
    const clk = makeClock(utcMidnight('2025-01-01') + 1_000);
    const tracker = new GuardTracker({ maxLossPerDayLamports: 100n }, clk.now);
    expect(tracker.recordRealized(100n)).toBeNull();  // profit
    expect(tracker.recordRealized(-100n)).toBeNull(); // cumulative 0n
  });
});

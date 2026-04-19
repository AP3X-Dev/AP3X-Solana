import { describe, it, expect } from 'vitest';

import { LatencyTracker } from './latency-tracker';

describe('LatencyTracker — invariants', () => {
  it('empty tracker returns Infinity for ewma (sorts last by design)', () => {
    const t = new LatencyTracker();
    expect(t.ewma()).toBe(Infinity);
    expect(t.samples()).toBe(0);
  });

  it('single sample seeds the EWMA directly', () => {
    const t = new LatencyTracker();
    t.record(123);
    expect(t.ewma()).toBe(123);
    expect(t.samples()).toBe(1);
  });

  it('exposes a WINDOW of 50 and ALPHA = 2 / (WINDOW + 1)', () => {
    expect(LatencyTracker.WINDOW).toBe(50);
    expect(LatencyTracker.ALPHA).toBeCloseTo(2 / 51, 10);
  });
});

describe('LatencyTracker — EWMA convergence', () => {
  it('EWMA moves toward a new stable sample but doesn\'t snap instantly', () => {
    const t = new LatencyTracker();
    t.record(100); // seeded at 100
    t.record(200); // blend toward 200 but weight is ~0.039 => ~103.92
    const after = t.ewma();
    expect(after).toBeGreaterThan(100);
    expect(after).toBeLessThan(200);
    // Exact expected: ALPHA * 200 + (1 - ALPHA) * 100 = 100 + ALPHA * 100
    const alpha = LatencyTracker.ALPHA;
    expect(after).toBeCloseTo(100 + alpha * 100, 10);
  });

  it('repeated identical samples converge toward the sample value', () => {
    const t = new LatencyTracker();
    t.record(50);
    for (let i = 0; i < 500; i++) t.record(200);
    // After 500 samples of 200 following a seed of 50, the EWMA should be
    // within 0.01 of 200 — exponential decay of the old seed dominates.
    expect(t.ewma()).toBeCloseTo(200, 2);
  });

  it('direction of convergence tracks the new sample', () => {
    const t = new LatencyTracker();
    t.record(100);
    const ewma0 = t.ewma();
    t.record(50); // downward
    expect(t.ewma()).toBeLessThan(ewma0);
    t.record(500); // upward — moves back past ewma0 eventually
    expect(t.ewma()).toBeGreaterThan(50);
  });
});

describe('LatencyTracker — sample count cap', () => {
  it('samples() caps at WINDOW even after many records', () => {
    const t = new LatencyTracker();
    for (let i = 0; i < LatencyTracker.WINDOW * 3; i++) t.record(10);
    expect(t.samples()).toBe(LatencyTracker.WINDOW);
  });

  it('samples() reaches WINDOW after exactly WINDOW records', () => {
    const t = new LatencyTracker();
    for (let i = 0; i < LatencyTracker.WINDOW; i++) t.record(10);
    expect(t.samples()).toBe(LatencyTracker.WINDOW);
    // One more still caps.
    t.record(10);
    expect(t.samples()).toBe(LatencyTracker.WINDOW);
  });
});

import { describe, it, expect } from 'vitest';
import { Semaphore } from './backpressure.js';

describe('Semaphore', () => {
  it('rejects non-positive max', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(NaN)).toThrow();
  });

  it('starts at full capacity', () => {
    const s = new Semaphore(3);
    expect(s.capacity()).toBe(3);
    expect(s.inFlight()).toBe(0);
  });

  it('returns release functions for tryAcquire up to capacity', () => {
    const s = new Semaphore(2);
    const a = s.tryAcquire();
    const b = s.tryAcquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(s.inFlight()).toBe(2);
  });

  it('returns null when saturated', () => {
    const s = new Semaphore(1);
    const r = s.tryAcquire();
    expect(r).not.toBeNull();
    expect(s.tryAcquire()).toBeNull();
  });

  it('release frees a slot', () => {
    const s = new Semaphore(1);
    const release = s.tryAcquire()!;
    release();
    expect(s.inFlight()).toBe(0);
    expect(s.tryAcquire()).not.toBeNull();
  });

  it('release is idempotent — calling twice does not over-release', () => {
    const s = new Semaphore(1);
    const release = s.tryAcquire()!;
    release();
    release(); // double-call should no-op
    expect(s.inFlight()).toBe(0);
    // No third permit available — capacity is 1, only the first slot exists.
    s.tryAcquire(); // 1
    expect(s.tryAcquire()).toBeNull();
  });

  it('FIFO is not enforced — callers re-race for permits after release', () => {
    const s = new Semaphore(1);
    const r1 = s.tryAcquire()!;
    expect(s.tryAcquire()).toBeNull();
    r1();
    const r2 = s.tryAcquire();
    expect(r2).not.toBeNull();
  });
});

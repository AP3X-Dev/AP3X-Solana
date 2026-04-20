import { describe, it, expect, vi } from 'vitest';
import { BundleAccumulator } from './bundle-accumulator.js';

describe('BundleAccumulator', () => {
  it('flushes when bundle reaches 5 intents', async () => {
    const flushed: number[] = [];
    const acc = new BundleAccumulator({ windowMs: 1000, maxPerBundle: 5, onFlush: (b) => { flushed.push(b.length); return Promise.all(b.map((p) => Promise.resolve('uuid'))); } });
    const promises = Array.from({ length: 5 }, (_, i) => acc.add('group1', { signedTx: new Uint8Array([i]) }));
    await Promise.all(promises);
    expect(flushed).toEqual([5]);
  });

  it('flushes after windowMs elapses', async () => {
    vi.useFakeTimers();
    const flushed: number[] = [];
    const acc = new BundleAccumulator({ windowMs: 50, maxPerBundle: 5, onFlush: (b) => { flushed.push(b.length); return Promise.all(b.map(() => Promise.resolve('uuid'))); } });
    void acc.add('group1', { signedTx: new Uint8Array([1]) });
    void acc.add('group1', { signedTx: new Uint8Array([2]) });
    vi.advanceTimersByTime(60);
    await vi.runAllTimersAsync();
    expect(flushed).toEqual([2]);
    vi.useRealTimers();
  });

  it('isolates bundles by group', async () => {
    vi.useFakeTimers();
    const flushed: Array<{ size: number }> = [];
    const acc = new BundleAccumulator({ windowMs: 50, maxPerBundle: 5, onFlush: (b) => { flushed.push({ size: b.length }); return Promise.all(b.map(() => Promise.resolve('uuid'))); } });
    void acc.add('a', { signedTx: new Uint8Array([1]) });
    void acc.add('b', { signedTx: new Uint8Array([2]) });
    void acc.add('a', { signedTx: new Uint8Array([3]) });
    vi.advanceTimersByTime(60);
    await vi.runAllTimersAsync();
    expect(flushed.map((f) => f.size).sort()).toEqual([1, 2]);
    vi.useRealTimers();
  });
});

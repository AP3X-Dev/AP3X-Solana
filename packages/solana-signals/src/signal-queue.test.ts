import { describe, it, expect, vi } from 'vitest';
import { SignalQueue } from './signal-queue.js';
import type { Signal } from './signal.js';
import { PublicKey } from '@ap3x/solana-core';

const mkSignal = (id: string): Signal => ({
  signalId: id,
  ts: 0, slot: 0, signature: id,
  programId: PublicKey.fromBase58('11111111111111111111111111111111'),
  kind: 'test', decoded: {}, raw: { programId: PublicKey.fromBase58('11111111111111111111111111111111'), accounts: [], logs: [], inner: [] },
});

describe('SignalQueue', () => {
  it('delivers signals to a subscriber in push order', async () => {
    const q = new SignalQueue({ capacity: 100 });
    const seen: string[] = [];
    q.subscribe('sub', async (s) => { seen.push(s.signalId); });
    await q.push(mkSignal('a'));
    await q.push(mkSignal('b'));
    await q.push(mkSignal('c'));
    await q.drain();
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('drops duplicates within the dedup window', async () => {
    const q = new SignalQueue({ capacity: 100, dedupWindow: 10, dedupTtlMs: 60_000 });
    const seen: string[] = [];
    q.subscribe('sub', async (s) => { seen.push(s.signalId); });
    await q.push(mkSignal('a'));
    await q.push(mkSignal('a')); // dup
    await q.push(mkSignal('b'));
    await q.drain();
    expect(seen).toEqual(['a', 'b']);
  });

  it('emits overflow event and drops oldest when capacity hit', async () => {
    const q = new SignalQueue({ capacity: 2 });
    const overflow = vi.fn();
    q.on('overflow', overflow);
    // No subscriber → backlog accumulates.
    await q.push(mkSignal('a'));
    await q.push(mkSignal('b'));
    await q.push(mkSignal('c'));
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(overflow.mock.calls[0]![0]).toMatchObject({ count: 1 });
  });

  it('expires dedup entries after dedupTtlMs', async () => {
    vi.useFakeTimers();
    const q = new SignalQueue({ capacity: 100, dedupWindow: 10, dedupTtlMs: 1000 });
    const seen: string[] = [];
    q.subscribe('sub', async (s) => { seen.push(s.signalId); });
    await q.push(mkSignal('a'));
    vi.advanceTimersByTime(2000);
    await q.push(mkSignal('a')); // re-allowed after TTL
    await q.drain();
    expect(seen).toEqual(['a', 'a']);
    vi.useRealTimers();
  });
});

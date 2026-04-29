import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PublicKey } from '@ap3x/solana-core';
import type { SignalSource } from './source.js';
import type { Signal } from './signal.js';
import { wrapSource } from './producer.js';

const PROGRAM = PublicKey.fromBase58('11111111111111111111111111111111');

class FakeSource extends EventEmitter implements SignalSource {
  readonly name = 'fake';
  started = false;
  stopped = false;
  async start(): Promise<void> { this.started = true; }
  async stop():  Promise<void> { this.stopped = true; }
  pushSignal(s: Signal): void { this.emit('signal', s); }
  pushError(): void { this.emit('error', new Error('boom')); }
}

function mkSignal(id: string, version?: string): Signal {
  const sig: Signal = {
    signalId: id,
    ts: 1,
    slot: 1,
    signature: 'sig-' + id,
    programId: PROGRAM,
    kind: 'swap',
    decoded: { value: id },
    raw: { programId: PROGRAM.toBase58(), depth: 1, success: true, logs: [], dataPayloads: [], children: [], rawLines: [] },
  };
  if (version !== undefined) sig.signalVersion = version;
  return sig;
}

describe('wrapSource', () => {
  it('returns a SignalProducer with the requested metadata', () => {
    const src = new FakeSource();
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v1' });
    expect(p.id).toBe('p1');
    expect(p.source).toBe('fake');
    expect(p.signalType).toBe('swap');
    expect(p.signalVersion).toBe('v1');
    expect(p.health()).toEqual({ ok: true });
  });

  it('starts the underlying source and forwards every emitted signal', async () => {
    const src = new FakeSource();
    const seen: Signal[] = [];
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v1' });

    await p.start(async (s) => { seen.push(s); });
    expect(src.started).toBe(true);

    src.pushSignal(mkSignal('a'));
    src.pushSignal(mkSignal('b'));

    // microtask drain
    await new Promise((r) => setImmediate(r));

    expect(seen.map((s) => s.signalId)).toEqual(['a', 'b']);
  });

  it('stamps signalVersion on signals that lack one', async () => {
    const src = new FakeSource();
    const seen: Signal[] = [];
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v1' });

    await p.start(async (s) => { seen.push(s); });
    src.pushSignal(mkSignal('a'));
    await new Promise((r) => setImmediate(r));

    expect(seen[0]?.signalVersion).toBe('v1');
  });

  it('preserves an explicitly-stamped signalVersion from the source', async () => {
    const src = new FakeSource();
    const seen: Signal[] = [];
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v2' });

    await p.start(async (s) => { seen.push(s); });
    src.pushSignal(mkSignal('a', 'pre-stamped'));
    await new Promise((r) => setImmediate(r));

    expect(seen[0]?.signalVersion).toBe('pre-stamped');
  });

  it('updates health.lastEmitAt and exposes ok=true while healthy', async () => {
    const src = new FakeSource();
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v1' });

    await p.start(async () => {});
    expect(p.health().lastEmitAt).toBeUndefined();

    const before = Date.now();
    src.pushSignal(mkSignal('a'));
    await new Promise((r) => setImmediate(r));

    const h = p.health();
    expect(h.ok).toBe(true);
    expect(h.lastEmitAt).toBeInstanceOf(Date);
    expect(h.lastEmitAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('sets health.ok=false on source error', async () => {
    const src = new FakeSource();
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v1' });

    await p.start(async () => {});
    src.pushError();
    expect(p.health().ok).toBe(false);
  });

  it('start is idempotent — calling twice does not re-start the source', async () => {
    const src = new FakeSource();
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v1' });

    await p.start(async () => {});
    src.started = false; // reset to detect a second start
    await p.start(async () => {});

    expect(src.started).toBe(false); // never re-set
  });

  it('stop is idempotent', async () => {
    const src = new FakeSource();
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v1' });

    await p.start(async () => {});
    await p.stop();
    expect(src.stopped).toBe(true);

    src.stopped = false;
    await p.stop();
    expect(src.stopped).toBe(false); // not re-stopped
  });

  it('drops signals received after stop()', async () => {
    const src = new FakeSource();
    const seen: Signal[] = [];
    const p = wrapSource({ source: src, id: 'p1', signalType: 'swap', signalVersion: 'v1' });

    await p.start(async (s) => { seen.push(s); });
    await p.stop();

    src.pushSignal(mkSignal('a')); // arrives after stop
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([]);
  });
});

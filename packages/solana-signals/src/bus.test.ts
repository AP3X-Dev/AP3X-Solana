import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import type { Signal } from './signal.js';
import type { SignalProducer, SignalConsumer } from './producer.js';
import { MemorySignalBus, VersionMismatchError } from './bus.js';

const PROGRAM = PublicKey.fromBase58('11111111111111111111111111111111');

function mkSignal(id: string, kind = 'swap', version?: string): Signal {
  const sig: Signal = {
    signalId: id,
    ts: 1,
    slot: 1,
    signature: 'sig-' + id,
    programId: PROGRAM,
    kind,
    decoded: { value: id },
    raw: { programId: PROGRAM.toBase58(), depth: 1, success: true, logs: [], dataPayloads: [], children: [], rawLines: [] },
  };
  if (version !== undefined) sig.signalVersion = version;
  return sig;
}

/**
 * A tiny in-test producer that exposes its `emit` so the test can drive it
 * directly. Avoids depending on wrapSource's adapter behaviour for bus tests.
 */
class TestProducer implements SignalProducer {
  private emit: ((s: Signal) => Promise<void>) | null = null;
  private started = false;

  constructor(
    public readonly id: string,
    public readonly source: string,
    public readonly signalType: string,
    public readonly signalVersion: string,
  ) {}

  async start(emit: (s: Signal) => Promise<void>): Promise<void> {
    this.emit = emit;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.emit = null;
    this.started = false;
  }

  health() { return { ok: this.started }; }

  /** Test helper — push a signal through the bus's emit shim. */
  async push(signal: Signal): Promise<void> {
    if (!this.emit) throw new Error('producer not started');
    await this.emit(signal);
  }
}

function recorder(id: string, opts: Partial<Omit<SignalConsumer, 'id' | 'handle'>> = {}): {
  consumer: SignalConsumer;
  seen: Signal[];
} {
  const seen: Signal[] = [];
  const consumer: SignalConsumer = {
    id,
    ...opts,
    async handle(s) { seen.push(s); },
  };
  return { consumer, seen };
}

/**
 * Wait for all registered producers' deferred start() to actually run.
 * The bus uses queueMicrotask; this drains it.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe('MemorySignalBus', () => {
  it('dispatches one producer\'s signal to one consumer', async () => {
    const bus = new MemorySignalBus();
    const p = new TestProducer('p1', 'src1', 'swap', 'v1');
    const { consumer, seen } = recorder('c1');

    bus.registerProducer(p);
    bus.registerConsumer(consumer);
    await flushMicrotasks();

    await p.push(mkSignal('a'));
    expect(seen.map((s) => s.signalId)).toEqual(['a']);
    expect(seen[0]?.signalVersion).toBe('v1'); // bus stamps if missing

    await bus.close();
  });

  it('fans out one signal to multiple consumers', async () => {
    const bus = new MemorySignalBus();
    const p = new TestProducer('p1', 'src1', 'swap', 'v1');
    const a = recorder('c-a');
    const b = recorder('c-b');

    bus.registerProducer(p);
    bus.registerConsumer(a.consumer);
    bus.registerConsumer(b.consumer);
    await flushMicrotasks();

    await p.push(mkSignal('x'));

    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(1);

    await bus.close();
  });

  it('routes signals from multiple producers to one consumer', async () => {
    const bus = new MemorySignalBus();
    const p1 = new TestProducer('p1', 'webhook', 'swap', 'v1');
    const p2 = new TestProducer('p2', 'geyser',  'swap', 'v1');
    const { consumer, seen } = recorder('c1');

    bus.registerProducer(p1);
    bus.registerProducer(p2);
    bus.registerConsumer(consumer);
    await flushMicrotasks();

    await p1.push(mkSignal('from-webhook'));
    await p2.push(mkSignal('from-geyser'));

    expect(seen.map((s) => s.signalId).sort()).toEqual(['from-geyser', 'from-webhook']);

    await bus.close();
  });

  it('filters by consumer.signalType', async () => {
    const bus = new MemorySignalBus();
    const swap = new TestProducer('p1', 'src', 'swap',     'v1');
    const xfer = new TestProducer('p2', 'src', 'transfer', 'v1');
    const swapOnly = recorder('swap-only', { signalType: 'swap' });

    bus.registerProducer(swap);
    bus.registerProducer(xfer);
    bus.registerConsumer(swapOnly.consumer);
    await flushMicrotasks();

    await swap.push(mkSignal('a', 'swap'));
    await xfer.push(mkSignal('b', 'transfer'));

    expect(swapOnly.seen.map((s) => s.signalId)).toEqual(['a']);

    await bus.close();
  });

  it('rejects mismatched versions when a consumer pins one and emits version-mismatch', async () => {
    const bus = new MemorySignalBus();
    const p = new TestProducer('p1', 'src', 'swap', 'v2');
    const pinned = recorder('pinned', { versionPin: 'v1' });
    const errors: VersionMismatchError[] = [];
    bus.on('version-mismatch', (e: VersionMismatchError) => errors.push(e));

    bus.registerProducer(p);
    bus.registerConsumer(pinned.consumer);
    await flushMicrotasks();

    await p.push(mkSignal('a'));

    expect(pinned.seen).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.consumerPin).toBe('v1');
    expect(errors[0]?.producerVersion).toBe('v2');

    await bus.close();
  });

  it('delivers signals when consumer.versionPin matches', async () => {
    const bus = new MemorySignalBus();
    const p = new TestProducer('p1', 'src', 'swap', 'v1');
    const pinned = recorder('pinned', { versionPin: 'v1' });

    bus.registerProducer(p);
    bus.registerConsumer(pinned.consumer);
    await flushMicrotasks();

    await p.push(mkSignal('a'));

    expect(pinned.seen).toHaveLength(1);

    await bus.close();
  });

  it('applies consumer.filter predicate after type/version checks', async () => {
    const bus = new MemorySignalBus();
    const p = new TestProducer('p1', 'src', 'swap', 'v1');
    const odd = recorder('odd', {
      filter: (s) => /^[13579]$/.test(s.signalId),
    });

    bus.registerProducer(p);
    bus.registerConsumer(odd.consumer);
    await flushMicrotasks();

    for (const id of ['1', '2', '3', '4', '5']) await p.push(mkSignal(id));

    expect(odd.seen.map((s) => s.signalId)).toEqual(['1', '3', '5']);

    await bus.close();
  });

  it('dedups by signalId across producers', async () => {
    const bus = new MemorySignalBus();
    const p1 = new TestProducer('p1', 'webhook', 'swap', 'v1');
    const p2 = new TestProducer('p2', 'geyser',  'swap', 'v1');
    const { consumer, seen } = recorder('c1');
    const drops: Array<{ reason: string; signalId: string }> = [];
    bus.on('dropped', (e) => drops.push(e));

    bus.registerProducer(p1);
    bus.registerProducer(p2);
    bus.registerConsumer(consumer);
    await flushMicrotasks();

    await p1.push(mkSignal('same'));
    await p2.push(mkSignal('same')); // dup — drop

    expect(seen).toHaveLength(1);
    expect(drops).toEqual([{ reason: 'dup', signalId: 'same' }]);

    await bus.close();
  });

  it('emits handler-error when a consumer throws — other consumers still receive', async () => {
    const bus = new MemorySignalBus();
    const p = new TestProducer('p1', 'src', 'swap', 'v1');
    const ok = recorder('ok');
    const bad: SignalConsumer = {
      id: 'bad',
      async handle() { throw new Error('boom'); },
    };
    const errs: Array<{ consumerId: string; error: unknown }> = [];
    bus.on('handler-error', (e) => errs.push(e));

    bus.registerProducer(p);
    bus.registerConsumer(bad);
    bus.registerConsumer(ok.consumer);
    await flushMicrotasks();

    await p.push(mkSignal('a'));

    expect(ok.seen).toHaveLength(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.consumerId).toBe('bad');

    await bus.close();
  });

  it('rejects duplicate producer ids', () => {
    const bus = new MemorySignalBus();
    bus.registerProducer(new TestProducer('p1', 's', 't', 'v1'));
    expect(() => bus.registerProducer(new TestProducer('p1', 's', 't', 'v1'))).toThrow(/already registered/);
  });

  it('rejects duplicate consumer ids', () => {
    const bus = new MemorySignalBus();
    const a = recorder('c1');
    const b = recorder('c1');
    bus.registerConsumer(a.consumer);
    expect(() => bus.registerConsumer(b.consumer)).toThrow(/already registered/);
  });

  it('disposeProducer stops the underlying producer', async () => {
    const bus = new MemorySignalBus();
    const p = new TestProducer('p1', 's', 'swap', 'v1');
    const handle = bus.registerProducer(p);
    await flushMicrotasks();

    expect(p.health().ok).toBe(true);
    handle.dispose();
    await flushMicrotasks();
    expect(p.health().ok).toBe(false);
  });

  it('close() stops every producer and clears consumers', async () => {
    const bus = new MemorySignalBus();
    const p1 = new TestProducer('p1', 's', 'swap', 'v1');
    const p2 = new TestProducer('p2', 's', 'swap', 'v1');
    bus.registerProducer(p1);
    bus.registerProducer(p2);
    await flushMicrotasks();

    await bus.close();

    expect(p1.health().ok).toBe(false);
    expect(p2.health().ok).toBe(false);
    expect(bus.listProducers()).toEqual([]);
    expect(bus.listConsumers()).toEqual([]);
  });
});

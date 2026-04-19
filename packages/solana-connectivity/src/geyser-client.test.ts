/**
 * GeyserClient tests.
 *
 * Two tiers:
 *
 *   1) Unit tests against a fake `GrpcAdapter`. These exercise enqueue,
 *      drain, gap detection, checkpointing, and backpressure — everything
 *      inside the class that isn't the gRPC transport itself. No sockets,
 *      no TLS, no proto-loader; deterministic and fast.
 *
 *   2) One integration test (`GeyserClient + real gRPC loopback`) that
 *      spins up an in-process `@grpc/grpc-js` server, loads the vendored
 *      proto via `@grpc/proto-loader`, and asserts that the default adapter
 *      wires up against the real transport. This guards against regressions
 *      in the proto vendoring (wrong filename, broken import path, missing
 *      includeDirs) that the fake-adapter tests would miss.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

import {
  GeyserClient,
  resolveProtoDir,
  type GeyserEndpoint,
  type GeyserUpdate,
  type GrpcAdapter,
  type GrpcClientHandle,
  type GrpcDuplexStream,
  type Subscription,
  type SubscribeRequest,
} from './geyser-client';
import type { CheckpointStore, Checkpoint } from './checkpoint-store';

// ---------------------------------------------------------------------------
// Fake gRPC adapter
// ---------------------------------------------------------------------------

/**
 * FakeStream is an EventEmitter with write/end/cancel shims. We cast it to
 * `GrpcDuplexStream` at the boundary — matching the strict overloaded `on`
 * signatures inside the class would require re-declaring them for no test
 * value.
 */
class FakeStream extends EventEmitter {
  writes: unknown[] = [];
  cancelled = false;
  ended = false;

  write(message: unknown): boolean {
    this.writes.push(message);
    return true;
  }

  end(): void {
    this.ended = true;
    this.emit('end');
  }

  cancel(): void {
    this.cancelled = true;
    this.emit('close');
  }

  /** Helper: push a data message synchronously. */
  pushData(update: GeyserUpdate): void {
    this.emit('data', update);
  }

  /** Helper: push an error. */
  pushError(err: Error): void {
    this.emit('error', err);
  }

  asDuplex(): GrpcDuplexStream {
    return this as unknown as GrpcDuplexStream;
  }
}

class FakeClient implements GrpcClientHandle {
  stream = new FakeStream();
  closed = false;
  subscribe(): GrpcDuplexStream {
    return this.stream.asDuplex();
  }
  close(): void {
    this.closed = true;
  }
}

function mkFakeAdapter(): { adapter: GrpcAdapter; client: FakeClient } {
  const client = new FakeClient();
  const adapter: GrpcAdapter = {
    createClient() {
      return client;
    },
  };
  return { adapter, client };
}

const ENDPOINT: GeyserEndpoint = { url: 'fake://localhost', insecure: true };

function slotUpdate(slot: number): GeyserUpdate {
  return { slot: { slot } };
}

function accountUpdate(slot: number, pubkey = 'p'): GeyserUpdate {
  return { account: { slot, pubkey } };
}

/** Wait until `pred()` returns true, or throw after `timeoutMs`. */
async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('GeyserClient — construction', () => {
  it('throws when endpoint URL is missing', () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => new GeyserClient({ endpoint: {} as any }),
    ).toThrow(/endpoint URL/);
  });

  it('throws when queueCapacity is < 1', () => {
    expect(
      () => new GeyserClient({ endpoint: ENDPOINT, queueCapacity: 0 }),
    ).toThrow(/queueCapacity/);
  });

  it('throws when checkpointEvery is < 1', () => {
    expect(
      () => new GeyserClient({ endpoint: ENDPOINT, checkpointEvery: 0 }),
    ).toThrow(/checkpointEvery/);
  });

  it('resolves the vendored proto directory', () => {
    const dir = resolveProtoDir();
    // The resolved dir should contain yellowstone.proto in either
    // src/proto/ (test run) or dist/proto/ (post-build).
    expect(dir).toMatch(/proto$/);
  });
});

// ---------------------------------------------------------------------------
// Request encoding + basic stream lifecycle
// ---------------------------------------------------------------------------

describe('GeyserClient — request and lifecycle', () => {
  it('writes an encoded SubscribeRequest on subscribe', async () => {
    const { adapter, client } = mkFakeAdapter();
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const req: SubscribeRequest = {
      accounts: { all: { owner: ['Token'] } },
      slots: { slots: { filterByCommitment: true } },
      commitment: 'confirmed',
    };
    const sub = geyser.subscribe(req, () => {});
    // The subscribe request is written synchronously in start().
    expect(client.stream.writes).toHaveLength(1);
    const written = client.stream.writes[0] as Record<string, unknown>;
    expect(written.accounts).toEqual({ all: { owner: ['Token'] } });
    expect(written.slots).toEqual({ slots: { filterByCommitment: true } });
    expect(written.commitment).toBe(1); // CONFIRMED
    sub.close();
    await waitUntil(() => client.closed || client.stream.cancelled);
  });

  it('delivers N updates to the handler in order', async () => {
    const { adapter, client } = mkFakeAdapter();
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const seen: GeyserUpdate[] = [];
    const sub = geyser.subscribe({}, (u) => {
      seen.push(u);
    });
    client.stream.pushData(slotUpdate(100));
    client.stream.pushData(slotUpdate(101));
    client.stream.pushData(slotUpdate(102));
    await waitUntil(() => seen.length === 3);
    expect(seen.map((u) => u.slot?.slot)).toEqual([100, 101, 102]);
    sub.close();
  });

  it('emits "update" after the handler runs (observation after commit)', async () => {
    const { adapter, client } = mkFakeAdapter();
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const order: string[] = [];
    const sub = geyser.subscribe({}, async () => {
      order.push('handler');
    });
    sub.on('update', () => {
      order.push('update-event');
    });
    client.stream.pushData(slotUpdate(10));
    await waitUntil(() => order.length === 2);
    expect(order).toEqual(['handler', 'update-event']);
    sub.close();
  });

  it('close() tears down the stream and emits "closed"', async () => {
    const { adapter, client } = mkFakeAdapter();
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const sub = geyser.subscribe({}, () => {});
    const closed = vi.fn();
    sub.on('closed', closed);
    sub.close();
    await waitUntil(() => closed.mock.calls.length === 1);
    expect(client.stream.cancelled).toBe(true);
    expect(client.closed).toBe(true);
    // close() is idempotent.
    sub.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('ignores data after close()', async () => {
    const { adapter, client } = mkFakeAdapter();
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const handler = vi.fn();
    const sub = geyser.subscribe({}, handler);
    sub.close();
    client.stream.pushData(slotUpdate(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
  });

  it('stream "end" event produces "closed"', async () => {
    const { adapter, client } = mkFakeAdapter();
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const sub = geyser.subscribe({}, () => {});
    const closed = vi.fn();
    sub.on('closed', closed);
    client.stream.emit('end');
    await waitUntil(() => closed.mock.calls.length === 1);
  });
});

// ---------------------------------------------------------------------------
// Backpressure / drop-oldest queue
// ---------------------------------------------------------------------------

describe('GeyserClient — backpressure', () => {
  it('drops oldest when the queue overflows and emits "dropped"', async () => {
    const { adapter, client } = mkFakeAdapter();
    // Slow handler — gate it on an external flag so we can stuff the queue
    // before it drains.
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const seen: GeyserUpdate[] = [];
    const geyser = new GeyserClient({
      endpoint: ENDPOINT,
      grpc: adapter,
      queueCapacity: 3,
    });
    const sub = geyser.subscribe({}, async (u) => {
      if (seen.length === 0) {
        // Only the first update blocks; subsequent ones run fast so we can
        // inspect post-drop ordering.
        await blocker;
      }
      seen.push(u);
    });
    const drops: Array<{ count: number; since: string }> = [];
    sub.on('dropped', (d: { count: number; since: string }) => drops.push(d));

    // Push 6 updates while the handler is stuck on the first. Queue cap=3,
    // so after push #1 enters the handler, the queue fills to 3 and the
    // next 2 pushes drop the oldest in-queue item each.
    client.stream.pushData(slotUpdate(1));
    // Give the drain loop a tick to pick up #1 into the handler.
    await new Promise((r) => setTimeout(r, 5));
    client.stream.pushData(slotUpdate(2));
    client.stream.pushData(slotUpdate(3));
    client.stream.pushData(slotUpdate(4));
    client.stream.pushData(slotUpdate(5));
    client.stream.pushData(slotUpdate(6));

    // Queue now holds [4,5,6] (2 and 3 dropped). Two drop events were emitted.
    await waitUntil(() => drops.length === 2);
    expect(drops[0]!.count).toBe(1);
    expect(drops[1]!.count).toBe(2);
    expect(drops[1]!.since).toMatch(/\d{4}-\d{2}-\d{2}T/);

    // Release the handler. We should see 1, then 4, 5, 6 — NOT 2 or 3.
    release!();
    await waitUntil(() => seen.length === 4);
    expect(seen.map((u) => u.slot?.slot)).toEqual([1, 4, 5, 6]);
    sub.close();
  });

  it('does not drop when the handler keeps up', async () => {
    const { adapter, client } = mkFakeAdapter();
    const drops: Array<{ count: number }> = [];
    const seen: GeyserUpdate[] = [];
    const geyser = new GeyserClient({
      endpoint: ENDPOINT,
      grpc: adapter,
      // Capacity exceeds the burst size. The drain loop `await`s even a
      // synchronous handler (because Promises.then chain micro-queues), so
      // a burst of N pushes before the first microtask turn will enqueue N
      // items — the queue must be large enough to absorb the burst to
      // assert the "no drops" property.
      queueCapacity: 50,
    });
    const sub = geyser.subscribe({}, (u) => {
      seen.push(u);
    });
    sub.on('dropped', (d: { count: number }) => drops.push(d));
    for (let i = 0; i < 20; i++) client.stream.pushData(slotUpdate(i));
    await waitUntil(() => seen.length === 20);
    expect(drops).toHaveLength(0);
    sub.close();
  });
});

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

describe('GeyserClient — gap detection', () => {
  it('emits "gap" when slots skip and calls onGap', async () => {
    const { adapter, client } = mkFakeAdapter();
    const gaps: Array<{ from: number; to: number }> = [];
    const onGap = vi.fn(async (_from: number, _to: number) => {});
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter, onGap });
    const sub = geyser.subscribe({}, () => {});
    sub.on('gap', (g: { from: number; to: number }) => gaps.push(g));
    client.stream.pushData(slotUpdate(100));
    client.stream.pushData(slotUpdate(101));
    client.stream.pushData(slotUpdate(105)); // gap 102..104
    await waitUntil(() => gaps.length === 1);
    expect(gaps[0]).toEqual({ from: 102, to: 105 });
    expect(onGap).toHaveBeenCalledWith(102, 105);
    sub.close();
  });

  it('does not emit "gap" on consecutive slots', async () => {
    const { adapter, client } = mkFakeAdapter();
    const gaps: unknown[] = [];
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const sub = geyser.subscribe({}, () => {});
    sub.on('gap', (g) => gaps.push(g));
    for (let i = 100; i <= 110; i++) client.stream.pushData(slotUpdate(i));
    await waitUntil(() => (sub as Subscription & { _done?: boolean }) && true, 50)
      .catch(() => {});
    // Let drain finish.
    await new Promise((r) => setTimeout(r, 10));
    expect(gaps).toHaveLength(0);
    sub.close();
  });

  it('ignores out-of-order (backwards) slot updates', async () => {
    const { adapter, client } = mkFakeAdapter();
    const gaps: unknown[] = [];
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const sub = geyser.subscribe({}, () => {});
    sub.on('gap', (g) => gaps.push(g));
    client.stream.pushData(slotUpdate(110));
    client.stream.pushData(slotUpdate(108)); // older — not a gap
    client.stream.pushData(slotUpdate(111));
    await new Promise((r) => setTimeout(r, 10));
    expect(gaps).toHaveLength(0);
    sub.close();
  });

  it('ignores non-slot updates for gap detection', async () => {
    const { adapter, client } = mkFakeAdapter();
    const gaps: unknown[] = [];
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const sub = geyser.subscribe({}, () => {});
    sub.on('gap', (g) => gaps.push(g));
    client.stream.pushData(slotUpdate(100));
    // Account update with slot 200 should NOT trigger a gap.
    client.stream.pushData(accountUpdate(200));
    client.stream.pushData(slotUpdate(101));
    await new Promise((r) => setTimeout(r, 10));
    expect(gaps).toHaveLength(0);
    sub.close();
  });

  it('surfaces onGap rejection as "error"', async () => {
    const { adapter, client } = mkFakeAdapter();
    const errors: Error[] = [];
    const geyser = new GeyserClient({
      endpoint: ENDPOINT,
      grpc: adapter,
      onGap: async () => {
        throw new Error('backfill failed');
      },
    });
    const sub = geyser.subscribe({}, () => {});
    sub.on('error', (e: Error) => errors.push(e));
    client.stream.pushData(slotUpdate(10));
    client.stream.pushData(slotUpdate(15));
    await waitUntil(() => errors.length === 1);
    expect(errors[0]!.message).toBe('backfill failed');
    sub.close();
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

class MemoryStore implements CheckpointStore {
  readonly saved: Array<{ key: string; ckpt: Checkpoint }> = [];
  readonly store = new Map<string, Checkpoint>();
  async load(key: string): Promise<Checkpoint | null> {
    return this.store.get(key) ?? null;
  }
  async save(key: string, ckpt: Checkpoint): Promise<void> {
    this.saved.push({ key, ckpt });
    this.store.set(key, ckpt);
  }
}

describe('GeyserClient — checkpoints', () => {
  it('persists a checkpoint every N updates', async () => {
    const { adapter, client } = mkFakeAdapter();
    const store = new MemoryStore();
    const geyser = new GeyserClient({
      endpoint: ENDPOINT,
      grpc: adapter,
      checkpointStore: store,
      checkpointEvery: 3,
      now: () => Date.UTC(2026, 3, 19, 0, 0, 0),
    });
    const sub = geyser.subscribe({}, () => {});
    // 7 updates → checkpoints at 3 and 6.
    for (let i = 100; i < 107; i++) client.stream.pushData(slotUpdate(i));
    await waitUntil(() => store.saved.length === 2);
    expect(store.saved[0]!.ckpt.updateCount).toBe(3);
    expect(store.saved[0]!.ckpt.lastSlot).toBe(102);
    expect(store.saved[1]!.ckpt.updateCount).toBe(6);
    expect(store.saved[1]!.ckpt.lastSlot).toBe(105);
    expect(store.saved[0]!.ckpt.timestamp).toBe(
      new Date(Date.UTC(2026, 3, 19, 0, 0, 0)).toISOString(),
    );
    sub.close();
  });

  it('loads the checkpoint on start and seeds gap detection', async () => {
    const { adapter, client } = mkFakeAdapter();
    const store = new MemoryStore();
    store.store.set('fake://localhost', {
      lastSlot: 999,
      updateCount: 500,
      timestamp: '2026-04-18T00:00:00.000Z',
    });
    const gaps: Array<{ from: number; to: number }> = [];
    const geyser = new GeyserClient({
      endpoint: ENDPOINT,
      grpc: adapter,
      checkpointStore: store,
    });
    const sub = geyser.subscribe({}, () => {});
    sub.on('gap', (g: { from: number; to: number }) => gaps.push(g));
    // Wait for the checkpoint load (scheduled in start()) to complete.
    await waitUntil(() => sub.loadedCheckpoint() !== null);
    expect(sub.loadedCheckpoint()).toEqual({
      lastSlot: 999,
      updateCount: 500,
      timestamp: '2026-04-18T00:00:00.000Z',
    });
    // Next slot jumps from 999 to 1100 → gap.
    client.stream.pushData(slotUpdate(1100));
    await waitUntil(() => gaps.length === 1);
    expect(gaps[0]).toEqual({ from: 1000, to: 1100 });
    sub.close();
  });

  it('uses the checkpointKey override when provided', async () => {
    const { adapter, client } = mkFakeAdapter();
    const store = new MemoryStore();
    const geyser = new GeyserClient({
      endpoint: ENDPOINT,
      grpc: adapter,
      checkpointStore: store,
      checkpointEvery: 1,
      checkpointKey: 'my-subscription',
    });
    const sub = geyser.subscribe({}, () => {});
    client.stream.pushData(slotUpdate(5));
    await waitUntil(() => store.saved.length === 1);
    expect(store.saved[0]!.key).toBe('my-subscription');
    sub.close();
  });

  it('emits "error" when the store throws on save, but keeps streaming', async () => {
    const { adapter, client } = mkFakeAdapter();
    const failing: CheckpointStore = {
      async load() {
        return null;
      },
      async save() {
        throw new Error('disk full');
      },
    };
    const errors: Error[] = [];
    const seen: GeyserUpdate[] = [];
    const geyser = new GeyserClient({
      endpoint: ENDPOINT,
      grpc: adapter,
      checkpointStore: failing,
      checkpointEvery: 1,
    });
    const sub = geyser.subscribe({}, (u) => {
      seen.push(u);
    });
    sub.on('error', (e: Error) => errors.push(e));
    client.stream.pushData(slotUpdate(1));
    client.stream.pushData(slotUpdate(2));
    await waitUntil(() => errors.length === 2 && seen.length === 2);
    expect(errors[0]!.message).toBe('disk full');
    sub.close();
  });

  it('emits "error" when the store throws on load, and proceeds without checkpoint', async () => {
    const { adapter, client } = mkFakeAdapter();
    const failing: CheckpointStore = {
      async load() {
        throw new Error('read failed');
      },
      async save() {},
    };
    const errors: Error[] = [];
    const geyser = new GeyserClient({
      endpoint: ENDPOINT,
      grpc: adapter,
      checkpointStore: failing,
    });
    const sub = geyser.subscribe({}, () => {});
    sub.on('error', (e: Error) => errors.push(e));
    client.stream.pushData(slotUpdate(1));
    await waitUntil(() => errors.length === 1);
    expect(errors[0]!.message).toBe('read failed');
    sub.close();
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe('GeyserClient — errors', () => {
  it('forwards stream errors as "error" events', async () => {
    const { adapter, client } = mkFakeAdapter();
    const errors: Error[] = [];
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const sub = geyser.subscribe({}, () => {});
    sub.on('error', (e: Error) => errors.push(e));
    client.stream.pushError(new Error('connection reset'));
    await waitUntil(() => errors.length === 1);
    expect(errors[0]!.message).toBe('connection reset');
    sub.close();
  });

  it('handler rejection surfaces as "error" and does not halt the stream', async () => {
    const { adapter, client } = mkFakeAdapter();
    const errors: Error[] = [];
    const seen: number[] = [];
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const sub = geyser.subscribe({}, async (u) => {
      const s = Number(u.slot?.slot);
      if (s === 2) throw new Error('handler boom');
      seen.push(s);
    });
    sub.on('error', (e: Error) => errors.push(e));
    client.stream.pushData(slotUpdate(1));
    client.stream.pushData(slotUpdate(2));
    client.stream.pushData(slotUpdate(3));
    await waitUntil(() => seen.length === 2 && errors.length === 1);
    expect(seen).toEqual([1, 3]);
    expect(errors[0]!.message).toBe('handler boom');
    sub.close();
  });

  it('createClient failure emits "error" and does not throw from subscribe()', async () => {
    const adapter: GrpcAdapter = {
      createClient() {
        throw new Error('cannot connect');
      },
    };
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const errors: Error[] = [];
    const sub = geyser.subscribe({}, () => {});
    sub.on('error', (e: Error) => errors.push(e));
    await waitUntil(() => errors.length === 1);
    expect(errors[0]!.message).toBe('cannot connect');
  });

  it('subscribe-stream failure emits "error"', async () => {
    const adapter: GrpcAdapter = {
      createClient() {
        return {
          subscribe() {
            throw new Error('stream open failed');
          },
          close() {},
        };
      },
    };
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const errors: Error[] = [];
    const sub = geyser.subscribe({}, () => {});
    sub.on('error', (e: Error) => errors.push(e));
    await waitUntil(() => errors.length === 1);
    expect(errors[0]!.message).toBe('stream open failed');
  });

  it('write failure on initial SubscribeRequest emits "error"', async () => {
    const stream = new FakeStream();
    stream.write = () => {
      throw new Error('write blocked');
    };
    const adapter: GrpcAdapter = {
      createClient() {
        return {
          subscribe: () => stream.asDuplex(),
          close() {},
        };
      },
    };
    const geyser = new GeyserClient({ endpoint: ENDPOINT, grpc: adapter });
    const errors: Error[] = [];
    const sub = geyser.subscribe({}, () => {});
    sub.on('error', (e: Error) => errors.push(e));
    await waitUntil(() => errors.length === 1);
    expect(errors[0]!.message).toBe('write blocked');
    sub.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: real in-process gRPC server with the vendored proto.
// ---------------------------------------------------------------------------

describe('GeyserClient — integration with real gRPC loopback', () => {
  // Lazy-load so a failed grpc-js install doesn't break the unit suite.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let grpc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let protoLoader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let port = 0;
  let tmpDir: string;

  beforeAll(async () => {
    grpc = await import('@grpc/grpc-js');
    protoLoader = await import('@grpc/proto-loader');
    tmpDir = mkdtempSync(join(tmpdir(), 'geyser-it-'));
    const protoPath = resolve(resolveProtoDir(), 'yellowstone.proto');
    const pkg = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: String,
      enums: Number,
      defaults: true,
      oneofs: true,
      includeDirs: [resolveProtoDir()],
    });
    const loaded = grpc.loadPackageDefinition(pkg);

    server = new grpc.Server();
    server.addService(loaded.geyser.Geyser.service, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe: (call: any) => {
        call.on('data', () => {
          // Synthetic slot stream: 100, 101, 105.
          call.write({ slot: { slot: '100', status: 0 } });
          call.write({ slot: { slot: '101', status: 0 } });
          call.write({ slot: { slot: '105', status: 0 } });
          call.end();
        });
        call.on('error', () => {});
      },
    });

    port = await new Promise<number>((resolveFn, reject) => {
      server.bindAsync(
        '127.0.0.1:0',
        grpc.ServerCredentials.createInsecure(),
        (err: Error | null, assignedPort: number) => {
          if (err) reject(err);
          else resolveFn(assignedPort);
        },
      );
    });
  }, 15_000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((r) => server.tryShutdown(() => r()));
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips updates through a real gRPC stream and detects a gap', async () => {
    const geyser = new GeyserClient({
      endpoint: { url: `127.0.0.1:${port}`, insecure: true },
    });
    const seen: number[] = [];
    const gaps: Array<{ from: number; to: number }> = [];
    const sub = geyser.subscribe({}, (u) => {
      if (u.slot?.slot !== undefined) seen.push(Number(u.slot.slot));
    });
    sub.on('gap', (g: { from: number; to: number }) => gaps.push(g));
    await waitUntil(() => seen.length === 3, 5_000);
    expect(seen).toEqual([100, 101, 105]);
    expect(gaps).toEqual([{ from: 102, to: 105 }]);
    sub.close();
  }, 10_000);
});

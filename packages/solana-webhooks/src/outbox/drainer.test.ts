import { describe, it, expect, beforeEach } from 'vitest';
import type {
  TypedSolanaEvent,
  WebhookDriver,
  RawWebhookEvent,
  VerifyResult,
} from '../types.js';
import type { Outbox, OutboxRow, PendingOptions } from './store.js';
import { Drainer } from './drainer.js';

// ---------------------------------------------------------------------------
// In-memory outbox for drainer unit tests (mirrors SqliteOutbox semantics).
// ---------------------------------------------------------------------------

class MemoryOutbox implements Outbox {
  rows: OutboxRow[] = [];
  initialised = false;

  async init(): Promise<void> { this.initialised = true; }

  async insert(event: { source: string; id: string; receivedAt: number; rawPayload: Uint8Array; metadata?: Readonly<Record<string, string>> }): Promise<boolean> {
    if (this.rows.find((r) => r.source === event.source && r.id === event.id)) return false;
    const row: OutboxRow = {
      ...event,
      rawPayload: new Uint8Array(event.rawPayload),
      processedAt: null,
      error: null,
      attempts: 0,
    };
    this.rows.push(row);
    return true;
  }

  async pending(opts: PendingOptions): Promise<OutboxRow[]> {
    const cap = opts.maxAttempts ?? Infinity;
    const sorted = this.rows
      .filter((r) => r.processedAt === null)
      .filter((r) => r.attempts < cap)
      .sort((a, b) => a.receivedAt - b.receivedAt);
    return sorted.slice(0, opts.limit);
  }

  async markProcessed(source: string, id: string, processedAt: number): Promise<void> {
    const row = this.rows.find((r) => r.source === source && r.id === id);
    if (!row) throw new Error(`no row (${source}, ${id})`);
    row.processedAt = processedAt;
    row.error = null;
  }

  async markFailed(source: string, id: string, error: string, attempts: number): Promise<void> {
    const row = this.rows.find((r) => r.source === source && r.id === id);
    if (!row) throw new Error(`no row (${source}, ${id})`);
    row.error = error;
    row.attempts = attempts;
  }

  async close(): Promise<void> { /* noop */ }
}

// ---------------------------------------------------------------------------
// Test driver — produces one DecodedEvent per row, optionally throwing.
// ---------------------------------------------------------------------------

function mkDriver(opts: {
  source: string;
  normalize?: (raw: RawWebhookEvent) => TypedSolanaEvent[];
} = { source: 'test' }): WebhookDriver {
  return {
    source: opts.source,
    verifyRequest(): VerifyResult { return { ok: true }; },
    parseRawPayload(): RawWebhookEvent[] { return []; },
    normalizeEvent: opts.normalize ?? ((raw) => [{
      kind: 'decoded',
      slot: 1,
      signature: `sig-${raw.id}`,
      programId: '11111111111111111111111111111111',
      data: { id: raw.id, payload: raw.payload },
    }]),
  };
}

function payloadBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Drainer', () => {
  let outbox: MemoryOutbox;

  beforeEach(() => {
    outbox = new MemoryOutbox();
  });

  describe('drainOnce', () => {
    it('processes pending rows and marks them processed', async () => {
      await outbox.insert({
        source: 'test', id: 'a', receivedAt: 1, rawPayload: payloadBytes({ x: 1 }),
      });
      await outbox.insert({
        source: 'test', id: 'b', receivedAt: 2, rawPayload: payloadBytes({ x: 2 }),
      });

      const seen: Array<{ event: TypedSolanaEvent; rowId: string }> = [];
      const drainer = new Drainer({
        outbox,
        drivers: { test: mkDriver({ source: 'test' }) },
        emit: async (event, ctx) => { seen.push({ event, rowId: ctx.rowId }); },
      });

      const result = await drainer.drainOnce();
      expect(result).toEqual({ processed: 2, failed: 0 });
      expect(seen.map((s) => s.rowId)).toEqual(['a', 'b']);
      expect(outbox.rows.every((r) => r.processedAt !== null)).toBe(true);
    });

    it('emits multiple typed events per row when normalize returns >1', async () => {
      await outbox.insert({
        source: 'test', id: 'multi', receivedAt: 1, rawPayload: payloadBytes({}),
      });
      const drainer = new Drainer({
        outbox,
        drivers: {
          test: mkDriver({
            source: 'test',
            normalize: (raw) => [
              { kind: 'decoded', slot: 1, signature: 'sa', programId: 'p', data: { i: 0, raw } },
              { kind: 'decoded', slot: 1, signature: 'sb', programId: 'p', data: { i: 1, raw } },
            ],
          }),
        },
        emit: async () => {},
      });

      const seen: TypedSolanaEvent[] = [];
      drainer['opts'].emit = async (event) => { seen.push(event); };

      const result = await drainer.drainOnce();
      expect(result.processed).toBe(1);
      expect(seen).toHaveLength(2);
    });

    it('marks failed when no driver is registered for the row source', async () => {
      await outbox.insert({
        source: 'unknown-source', id: 'a', receivedAt: 1, rawPayload: payloadBytes({}),
      });
      const drainer = new Drainer({
        outbox,
        drivers: { other: mkDriver({ source: 'other' }) },
        emit: async () => {},
        maxAttempts: 5,
      });

      const result = await drainer.drainOnce();
      expect(result).toEqual({ processed: 0, failed: 1 });
      expect(outbox.rows[0]?.error).toBe('no driver registered');
      expect(outbox.rows[0]?.attempts).toBe(5); // parked permanently
    });

    it('marks failed when stored payload is not valid JSON', async () => {
      await outbox.insert({
        source: 'test', id: 'a', receivedAt: 1, rawPayload: new TextEncoder().encode('%%not-json'),
      });
      const drainer = new Drainer({
        outbox,
        drivers: { test: mkDriver() },
        emit: async () => {},
      });
      const result = await drainer.drainOnce();
      expect(result.failed).toBe(1);
      expect(outbox.rows[0]?.error).toMatch(/payload parse/);
    });

    it('marks failed and increments attempts when normalize throws', async () => {
      await outbox.insert({
        source: 'test', id: 'a', receivedAt: 1, rawPayload: payloadBytes({}),
      });
      const drainer = new Drainer({
        outbox,
        drivers: {
          test: mkDriver({
            source: 'test',
            normalize: () => { throw new Error('decoder broke'); },
          }),
        },
        emit: async () => {},
      });

      await drainer.drainOnce();
      expect(outbox.rows[0]?.error).toMatch(/normalize: decoder broke/);
      expect(outbox.rows[0]?.attempts).toBe(1);

      // Re-attempt — attempts increments again.
      // (retryDelayMs = 1000 default would block this; override to 0 for the test.)
      const fastDrainer = new Drainer({
        outbox,
        drivers: {
          test: mkDriver({
            source: 'test',
            normalize: () => { throw new Error('still broken'); },
          }),
        },
        emit: async () => {},
        retryDelayMs: 0,
      });
      await fastDrainer.drainOnce();
      expect(outbox.rows[0]?.attempts).toBe(2);
    });

    it('marks failed when emit throws', async () => {
      await outbox.insert({
        source: 'test', id: 'a', receivedAt: 1, rawPayload: payloadBytes({}),
      });
      const drainer = new Drainer({
        outbox,
        drivers: { test: mkDriver() },
        emit: async () => { throw new Error('bus down'); },
      });
      await drainer.drainOnce();
      expect(outbox.rows[0]?.error).toMatch(/emit: bus down/);
      expect(outbox.rows[0]?.attempts).toBe(1);
    });

    it('respects maxAttempts cap (parked rows excluded from pending)', async () => {
      await outbox.insert({
        source: 'test', id: 'a', receivedAt: 1, rawPayload: payloadBytes({}),
      });
      // Force the row to high attempts.
      await outbox.markFailed('test', 'a', 'parked', 99);

      const drainer = new Drainer({
        outbox,
        drivers: { test: mkDriver() },
        emit: async () => {},
        maxAttempts: 5,
      });
      const result = await drainer.drainOnce();
      expect(result).toEqual({ processed: 0, failed: 0 }); // skipped
    });
  });

  describe('start/stop', () => {
    it('start() runs cycles in the background until stop()', async () => {
      // Insert one row; let the loop process it; verify processedAt is set.
      await outbox.insert({
        source: 'test', id: 'a', receivedAt: 1, rawPayload: payloadBytes({}),
      });
      const drainer = new Drainer({
        outbox,
        drivers: { test: mkDriver() },
        emit: async () => {},
        pollIntervalMs: 5,
      });
      await drainer.start();

      // Wait for the row to be processed.
      const deadline = Date.now() + 1000;
      while (outbox.rows[0]?.processedAt === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(outbox.rows[0]?.processedAt).not.toBeNull();

      await drainer.stop();
    });

    it('stop() is idempotent', async () => {
      const drainer = new Drainer({
        outbox,
        drivers: { test: mkDriver() },
        emit: async () => {},
      });
      await drainer.start();
      await drainer.stop();
      await drainer.stop();
    });

    it('start() is idempotent', async () => {
      const drainer = new Drainer({
        outbox,
        drivers: { test: mkDriver() },
        emit: async () => {},
      });
      await drainer.start();
      await drainer.start(); // second call no-ops
      await drainer.stop();
    });
  });
});

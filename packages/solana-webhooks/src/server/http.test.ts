/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import type {
  IncomingRequest,
  WebhookDriver,
  RawWebhookEvent,
  TypedSolanaEvent,
  VerifyResult,
} from '../types.js';
import type { Outbox, OutboxRow, PendingOptions } from '../outbox/store.js';
import { createReceiverHandler } from './http.js';

// ---------------------------------------------------------------------------
// In-memory Outbox stand-in. Mirrors SqliteOutbox's contract without the
// native dep. Used here so the HTTP tests stay independent of better-sqlite3.
// ---------------------------------------------------------------------------

class MemoryOutbox implements Outbox {
  private rows = new Map<string, OutboxRow>();
  initialised = false;

  async init(): Promise<void> { this.initialised = true; }

  async insert(event: { source: string; id: string; receivedAt: number; rawPayload: Uint8Array; metadata?: Readonly<Record<string, string>> }): Promise<boolean> {
    const key = `${event.source}::${event.id}`;
    if (this.rows.has(key)) return false;
    const row: OutboxRow = {
      ...event,
      rawPayload: new Uint8Array(event.rawPayload),
      processedAt: null,
      error: null,
      attempts: 0,
    };
    this.rows.set(key, row);
    return true;
  }

  async pending(opts: PendingOptions): Promise<OutboxRow[]> {
    const sorted = [...this.rows.values()]
      .filter((r) => r.processedAt === null)
      .sort((a, b) => a.receivedAt - b.receivedAt);
    return sorted.slice(0, opts.limit);
  }

  async markProcessed(): Promise<void> { /* unused in these tests */ }
  async markFailed(): Promise<void> { /* unused */ }
  async close(): Promise<void> { /* unused */ }

  size(): number { return this.rows.size; }
  list(): OutboxRow[] { return [...this.rows.values()]; }
}

// ---------------------------------------------------------------------------
// Test driver — accepts requests with `Authorization: secret`, parses JSON
// arrays of `{ id, ... }` records.
// ---------------------------------------------------------------------------

const TEST_SECRET = 'unit-test-secret';

function makeDriver(overrides: Partial<WebhookDriver> = {}): WebhookDriver {
  return {
    source: 'test',
    verifyRequest(req): VerifyResult {
      const auth = req.headers['authorization'];
      const v = Array.isArray(auth) ? auth[0] : auth;
      if (!v) return { ok: false, reason: 'missing-auth' };
      if (v !== TEST_SECRET) return { ok: false, reason: 'invalid-auth' };
      return { ok: true };
    },
    parseRawPayload(body: Uint8Array): RawWebhookEvent[] {
      const text = new TextDecoder().decode(body);
      const parsed: Array<{ id: string }> = JSON.parse(text);
      return parsed.map((p) => ({ id: p.id, source: 'test', payload: p }));
    },
    normalizeEvent(): TypedSolanaEvent[] { return []; }, // unused at this layer
    ...overrides,
  };
}

function mkRequest(opts: { auth?: string; body: string }): IncomingRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers['authorization'] = opts.auth;
  return {
    method: 'POST',
    url: '/webhook',
    headers,
    body: new TextEncoder().encode(opts.body),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createReceiverHandler — direct ingest()', () => {
  let outbox: MemoryOutbox;

  beforeEach(() => {
    outbox = new MemoryOutbox();
  });

  it('accepts a valid request and inserts each parsed event', async () => {
    const handler = createReceiverHandler({
      driver: makeDriver(),
      outbox,
    });

    const result = await handler.ingest(mkRequest({
      auth: TEST_SECRET,
      body: JSON.stringify([{ id: 'e1' }, { id: 'e2' }]),
    }));

    expect(result).toEqual({ status: 'accepted', eventCount: 2 });
    expect(outbox.size()).toBe(2);
  });

  it('returns auth/missing-auth on bare requests', async () => {
    const handler = createReceiverHandler({ driver: makeDriver(), outbox });
    const result = await handler.ingest(mkRequest({ body: '[]' }));
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe('auth');
  });

  it('returns auth/invalid-auth on bad secret', async () => {
    const handler = createReceiverHandler({ driver: makeDriver(), outbox });
    const result = await handler.ingest(mkRequest({ auth: 'wrong', body: '[]' }));
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe('auth');
  });

  it('returns too-large when body exceeds maxBytes', async () => {
    const handler = createReceiverHandler({
      driver: makeDriver(),
      outbox,
      maxBytes: 16,
    });
    const result = await handler.ingest(mkRequest({
      auth: TEST_SECRET,
      body: JSON.stringify([{ id: 'long-id-that-makes-the-body-large' }]),
    }));
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe('too-large');
  });

  it('returns saturated when concurrency cap is hit', async () => {
    let resolveFirst: (() => void) | null = null;
    const slowOutbox: Outbox = {
      ...outbox,
      init: () => Promise.resolve(),
      insert: async (e) => {
        // Hold the first insert open so the semaphore stays acquired.
        if (e.id === 'slow') await new Promise<void>((r) => { resolveFirst = r; });
        return outbox.insert(e);
      },
      pending: outbox.pending.bind(outbox),
      markProcessed: outbox.markProcessed.bind(outbox),
      markFailed: outbox.markFailed.bind(outbox),
      close: outbox.close.bind(outbox),
    };

    const handler = createReceiverHandler({
      driver: makeDriver(),
      outbox: slowOutbox,
      maxConcurrent: 1,
    });

    // Start one request that will hold the slot.
    const inFlight = handler.ingest(mkRequest({
      auth: TEST_SECRET,
      body: JSON.stringify([{ id: 'slow' }]),
    }));

    // Wait until the in-flight count reflects the held permit.
    while (handler.inFlight() < 1) await new Promise((r) => setImmediate(r));

    // Second request should be rejected as saturated.
    const second = await handler.ingest(mkRequest({
      auth: TEST_SECRET,
      body: JSON.stringify([{ id: 'fast' }]),
    }));
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') expect(second.reason).toBe('saturated');

    // Release the first.
    resolveFirst!();
    await inFlight;

    // Now a fresh request should go through.
    const third = await handler.ingest(mkRequest({
      auth: TEST_SECRET,
      body: JSON.stringify([{ id: 'after' }]),
    }));
    expect(third.status).toBe('accepted');
  });

  it('returns parse rejection when driver.parseRawPayload throws', async () => {
    const handler = createReceiverHandler({
      driver: makeDriver({
        parseRawPayload: () => { throw new Error('bad json'); },
      }),
      outbox,
    });
    const result = await handler.ingest(mkRequest({
      auth: TEST_SECRET,
      body: '%%%-not-json',
    }));
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe('parse');
  });

  it('treats duplicate inserts as accepted (zero new events)', async () => {
    const handler = createReceiverHandler({ driver: makeDriver(), outbox });
    const a = await handler.ingest(mkRequest({
      auth: TEST_SECRET,
      body: JSON.stringify([{ id: 'dup' }]),
    }));
    const b = await handler.ingest(mkRequest({
      auth: TEST_SECRET,
      body: JSON.stringify([{ id: 'dup' }]),
    }));
    expect(a).toEqual({ status: 'accepted', eventCount: 1 });
    expect(b).toEqual({ status: 'accepted', eventCount: 0 });
    expect(outbox.size()).toBe(1);
  });
});

describe('createReceiverHandler — Node http integration', () => {
  let outbox: MemoryOutbox;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    outbox = new MemoryOutbox();
    const handler = createReceiverHandler({ driver: makeDriver(), outbox });
    server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}/webhook`;
  });

  async function close(): Promise<void> {
    await new Promise<void>((r) => server.close(() => r()));
  }

  it('returns 200 OK on a valid request', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': TEST_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: 'http-1' }]),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; count: number };
    expect(body).toEqual({ status: 'ok', count: 1 });
    await close();
  });

  it('returns 401 on bad auth', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'wrong' },
      body: '[]',
    });
    expect(res.status).toBe(401);
    await close();
  });

  it('returns 405 on non-POST', async () => {
    const res = await fetch(url, { method: 'GET' });
    expect(res.status).toBe(405);
    await close();
  });

  it('returns 413 when the request body exceeds maxBytes', async () => {
    await close();
    // Recreate with tight maxBytes.
    const handler = createReceiverHandler({
      driver: makeDriver(),
      outbox,
      maxBytes: 16,
    });
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as AddressInfo;
    const u = `http://127.0.0.1:${addr.port}/webhook`;

    const big = JSON.stringify([{ id: 'this-id-is-way-too-long-for-the-cap' }]);
    const res = await fetch(u, {
      method: 'POST',
      headers: { 'Authorization': TEST_SECRET },
      body: big,
    });
    expect(res.status).toBe(413);
    await close();
  });
});

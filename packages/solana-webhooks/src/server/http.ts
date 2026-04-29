import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createNodeServer, type Server } from 'node:http';
import type {
  IncomingRequest,
  IngestResult,
  WebhookDriver,
  MetricsEmitter,
} from '../types.js';
import type { Outbox } from '../outbox/store.js';
import { Semaphore } from './backpressure.js';
import { noopMetrics } from '../types.js';

/** Default body size cap. Can be overridden per receiver. */
export const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

/** Default max in-flight requests before backpressure. */
export const DEFAULT_MAX_CONCURRENT = 64;

export interface ReceiverOptions {
  /** Driver implementation (Helius is the first). */
  driver: WebhookDriver;
  /** Outbox to persist raw events to. */
  outbox: Outbox;
  /**
   * Max body bytes per request. Requests exceeding this get `413 Payload
   * Too Large` with no body persisted. Default 1 MiB.
   */
  maxBytes?: number;
  /**
   * Max concurrent in-flight requests. Beyond this, new requests get `503
   * Service Unavailable` so the upstream provider backs off. Default 64.
   */
  maxConcurrent?: number;
  /** Optional metrics sink. */
  metrics?: MetricsEmitter;
  /**
   * Now-function for testability. Defaults to `Date.now`. Determines the
   * `receivedAt` stamp on stored events.
   */
  now?: () => number;
}

/**
 * Build a Node `http`-compatible request handler that ingests webhook
 * deliveries. The handler:
 *
 *   1. Reads the request body up to `maxBytes` (returns 413 on overflow).
 *   2. Verifies the request via the driver's {@link WebhookDriver.verifyRequest}
 *      (returns 401 on auth failure).
 *   3. Acquires a backpressure semaphore slot (returns 503 when saturated).
 *   4. Hands the body to the driver's {@link WebhookDriver.parseRawPayload}
 *      and inserts each parsed sub-event into the outbox.
 *   5. Returns 200 immediately — decoding is the drainer's job.
 *
 * The handler logs a stable {@link IngestResult} via the metrics emitter for
 * every request so operators can alert on rejection patterns.
 */
export interface ReceiverHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Direct programmatic interface — bypass HTTP for tests / replay-from-archive. */
  ingest(req: IncomingRequest): Promise<IngestResult>;
  /** Current backpressure state. */
  inFlight(): number;
  /** Capacity. */
  capacity(): number;
}

export function createReceiverHandler(opts: ReceiverOptions): ReceiverHandler {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const semaphore = new Semaphore(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const metrics = opts.metrics ?? noopMetrics;
  const now = opts.now ?? Date.now;
  const driver = opts.driver;
  const outbox = opts.outbox;

  // Direct ingest. The HTTP handler builds an IncomingRequest and calls this.
  async function ingest(req: IncomingRequest): Promise<IngestResult> {
    metrics.count('ap3x.webhooks.received', 1, { source: driver.source });

    // 1. Auth.
    const verify = driver.verifyRequest(req);
    if (!verify.ok) {
      metrics.count('ap3x.webhooks.rejected', 1, { source: driver.source, reason: 'auth' });
      return { status: 'rejected', reason: 'auth', detail: verify.reason };
    }

    // 2. Size cap (the HTTP layer enforces this on the wire; ingest() callers
    //    bypass that, so we re-check on the in-memory body too).
    if (req.body.byteLength > maxBytes) {
      metrics.count('ap3x.webhooks.rejected', 1, { source: driver.source, reason: 'too-large' });
      return { status: 'rejected', reason: 'too-large', detail: `${req.body.byteLength} > ${maxBytes}` };
    }

    // 3. Backpressure.
    const release = semaphore.tryAcquire();
    if (!release) {
      metrics.count('ap3x.webhooks.rejected', 1, { source: driver.source, reason: 'saturated' });
      return { status: 'rejected', reason: 'saturated' };
    }

    try {
      // 4. Parse + persist.
      let parsed;
      try {
        parsed = driver.parseRawPayload(req.body);
      } catch (err) {
        metrics.count('ap3x.webhooks.rejected', 1, { source: driver.source, reason: 'parse' });
        return {
          status: 'rejected',
          reason: 'parse',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      const receivedAt = now();
      let inserted = 0;
      let duplicates = 0;
      for (const event of parsed) {
        // Persist the per-tx payload, not the wire body. The drainer reads
        // exactly one tx's data per row, so storing only that slice keeps
        // outbox rows compact and the drainer's parse step trivial.
        const perTxBody = new TextEncoder().encode(JSON.stringify(event.payload));
        const wasNew = await outbox.insert({
          id: event.id,
          source: driver.source,
          receivedAt,
          rawPayload: perTxBody,
        });
        if (wasNew) inserted += 1;
        else duplicates += 1;
      }

      if (duplicates > 0 && inserted === 0) {
        metrics.count('ap3x.webhooks.replay', duplicates, { source: driver.source });
      } else if (inserted > 0) {
        metrics.count('ap3x.webhooks.accepted', inserted, { source: driver.source });
      }

      metrics.observe('ap3x.webhooks.body_bytes', req.body.byteLength, { source: driver.source });
      return { status: 'accepted', eventCount: inserted };
    } finally {
      release();
    }
  }

  // HTTP adapter.
  const handler: ReceiverHandler = (async (req: IncomingMessage, res: ServerResponse) => {
    const remoteAddress = req.socket.remoteAddress ?? undefined;

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    let body: Uint8Array;
    try {
      body = await readBody(req, maxBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        metrics.count('ap3x.webhooks.rejected', 1, { source: driver.source, reason: 'too-large' });
        sendJson(res, 413, { error: 'payload-too-large' });
        return;
      }
      sendJson(res, 400, { error: 'bad-request' });
      return;
    }

    const incoming: IncomingRequest = {
      method: req.method,
      url: req.url ?? '/',
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
    };
    if (remoteAddress) incoming.remoteAddress = remoteAddress;

    const result = await ingest(incoming);

    if (result.status === 'accepted') {
      sendJson(res, 200, { status: 'ok', count: result.eventCount });
      return;
    }

    switch (result.reason) {
      case 'auth':
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      case 'too-large':
        sendJson(res, 413, { error: 'payload-too-large' });
        return;
      case 'saturated':
        sendJson(res, 503, { error: 'saturated' });
        return;
      case 'parse':
        sendJson(res, 400, { error: 'bad-payload', detail: result.detail });
        return;
      case 'replay':
        sendJson(res, 200, { status: 'duplicate' });
        return;
      default:
        sendJson(res, 500, { error: 'internal' });
        return;
    }
  }) as ReceiverHandler;

  handler.ingest = ingest;
  handler.inFlight = () => semaphore.inFlight();
  handler.capacity = () => semaphore.capacity();
  return handler;
}

/**
 * Convenience wrapper that pairs the handler with `http.createServer`.
 * Consumers who need their own server (Express, Hono, etc.) skip this and
 * use the handler directly.
 */
export function createWebhookServer(opts: ReceiverOptions): {
  server: Server;
  handler: ReceiverHandler;
} {
  const handler = createReceiverHandler(opts);
  const server = createNodeServer((req, res) => {
    handler(req, res).catch((err) => {
      // Last-resort safety net: if anything in the handler throws, return 500
      // rather than leaving the socket open.
      // eslint-disable-next-line no-console
      console.error('[ap3x/solana-webhooks] handler threw:', err);
      try { sendJson(res, 500, { error: 'internal' }); } catch { /* noop */ }
    });
  });
  return { server, handler };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class PayloadTooLargeError extends Error {
  constructor(public readonly received: number, public readonly limit: number) {
    super(`Payload too large: ${received} > ${limit}`);
    this.name = 'PayloadTooLargeError';
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Drain the rest so the socket doesn't half-close.
        req.removeAllListeners('data');
        req.resume();
        reject(new PayloadTooLargeError(total, maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on('error', (err) => reject(err));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

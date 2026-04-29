import type { DecodedEvent, UnknownEventDecode } from '@ap3x/solana-events';

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/**
 * Framework-agnostic incoming request shape. The receiver can adapt Node
 * `http.IncomingMessage`, Express `Request`, Hono `Context`, or anything else
 * to this contract — the rest of the package operates on it without caring
 * about the specific HTTP library underneath.
 *
 * `body` is provided as raw bytes so HMAC verification can sign over the
 * exact wire form. Once verified, parsers may reinterpret it as JSON.
 */
export interface IncomingRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Uint8Array;
  /** Remote address. Optional — used for structured logging only. */
  remoteAddress?: string;
}

/** Verification verdict. `ok=false` carries a stable `reason` for response mapping. */
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing-auth' | 'invalid-auth' | 'expired' | 'unknown'; detail?: string };

// ---------------------------------------------------------------------------
// Outbox + raw events
// ---------------------------------------------------------------------------

/**
 * One webhook delivery as observed by the receiver. Stored in the outbox raw
 * (as the bytes that arrived) so decoding bugs, schema drift, or downstream
 * consumer outages cannot lose events. The drainer parses + decodes
 * asynchronously.
 */
export interface WebhookEvent {
  /** Stable per-event identifier (provider-supplied). For Helius, derived from the payload's transaction signature(s) hashed with the webhook id. */
  id: string;
  /** Driver `source` (e.g. "helius"). */
  source: string;
  /** Monotonic millisecond timestamp the receiver acknowledged the request. */
  receivedAt: number;
  /** Exact bytes of the request body — the wire form HMAC was computed over. */
  rawPayload: Uint8Array;
  /** Optional driver-specific metadata captured from headers (e.g. webhookId, deliveryId). */
  metadata?: Readonly<Record<string, string>>;
}

/** Result of a `receive()` call — the receiver's reply for the HTTP layer to translate into status codes. */
export type IngestResult =
  | { status: 'accepted'; eventCount: number }
  | { status: 'rejected'; reason: 'auth' | 'too-large' | 'parse' | 'saturated' | 'replay'; detail?: string };

/**
 * One parsed-but-not-yet-normalized webhook event. The shape is provider-specific;
 * drivers know their own.
 */
export interface RawWebhookEvent {
  /** Source-stable id for idempotency. May equal the parent {@link WebhookEvent.id} for single-event payloads. */
  id: string;
  /** Driver source name. */
  source: string;
  /** Driver-defined parsed payload. The drainer hands this back to the driver's normalizeEvent. */
  payload: unknown;
}

/**
 * Normalized event the drainer publishes. Mirrors `@ap3x/solana-events`'
 * decoder output so consumers see the same shape from Geyser and from
 * webhooks. `kind === 'unknown'` carries decode failures as data, not as
 * thrown errors — preserving observability of variants we don't yet
 * understand.
 */
export type TypedSolanaEvent =
  | (DecodedEvent & { slot: number; signature: string })
  | (UnknownEventDecode & { slot: number; signature: string });

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

/**
 * Contract for a webhook provider. Helius is the first implementation; future
 * drivers (different commercial provider, self-hosted Geyser→webhook bridge,
 * replay-from-archive driver) plug in by implementing this interface.
 *
 * `admin` and `catchup` are optional — drivers without webhook-management
 * APIs or RPC backfill simply don't set them.
 */
export interface WebhookDriver {
  /** Stable transport identifier. e.g. "helius". */
  readonly source: string;
  /** Verify the request authenticates as coming from this driver. */
  verifyRequest(req: IncomingRequest): VerifyResult;
  /** Parse the raw bytes into one or more {@link RawWebhookEvent} records. Many drivers batch. */
  parseRawPayload(body: Uint8Array): RawWebhookEvent[];
  /** Normalize a single raw event into one or more {@link TypedSolanaEvent}s. */
  normalizeEvent(raw: RawWebhookEvent): TypedSolanaEvent[];
  /** Optional config-sync API. */
  admin?: WebhookAdminClient;
  /** Optional gap-replay client. */
  catchup?: WebhookCatchupClient;
}

/**
 * Idempotent webhook config sync. Implemented per-driver against the provider's
 * management API (Helius's webhook CRUD endpoints, etc.). Apps wrap this with
 * vertical-specific decisions about which addresses to subscribe.
 */
export interface WebhookAdminClient {
  subscribeAddresses(webhookId: string, addresses: string[]): Promise<void>;
  removeAddresses(webhookId: string, addresses: string[]): Promise<void>;
  /** Idempotent diff/apply: bring webhookId's address set to exactly `desired`. */
  reconcile(webhookId: string, desired: string[]): Promise<{ added: string[]; removed: string[] }>;
}

/**
 * Gap-replay client for fetching events the webhook stream missed. Implementations
 * call `@ap3x/solana-connectivity`'s historical RPC backfill.
 */
export interface WebhookCatchupClient {
  /**
   * Fetch all signatures for `address` between `fromSlot` and `toSlot` (both
   * inclusive when present). Returns parsed transactions in slot order.
   */
  fetchRange(args: {
    address: string;
    fromSlot?: number;
    toSlot?: number;
    limit?: number;
  }): AsyncIterable<TypedSolanaEvent>;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Pluggable metrics sink. Adapters exist for `@ap3x/core`'s EventBus,
 * OpenTelemetry, Prometheus client libs, etc. — wire your collector to this
 * interface so the package itself stays metrics-agnostic.
 */
export interface MetricsEmitter {
  /** Increment a named counter. */
  count(name: string, delta?: number, attrs?: Readonly<Record<string, string>>): void;
  /** Record a numeric observation (latency, size). */
  observe(name: string, value: number, attrs?: Readonly<Record<string, string>>): void;
}

/** Convenience no-op emitter for tests and consumers who haven't wired metrics yet. */
export const noopMetrics: MetricsEmitter = {
  count: () => {},
  observe: () => {},
};

# @ap3x/solana-webhooks

Webhook ingestion as a peer transport to Geyser for the AP3X Solana substrate.

## Overview

`@ap3x/solana-webhooks` is a transport-shaped package for ingesting Solana on-chain events delivered as webhooks. It pairs with `@ap3x/solana-signals` — every webhook event becomes a `Signal` on the same multi-source bus that Geyser, historical RPC replay, and any future transport feeds into. Consumers subscribe by signal type, not by transport.

The package is driver-shaped: Helius is the first driver and the canonical reference; the receiver/outbox/backpressure/admin/catchup machinery is generic and accepts a `WebhookDriver` contract for future drivers (a self-hosted Geyser→webhook bridge, a second commercial provider, a replay-from-archive driver).

## Why webhooks, not just Geyser

Geyser is the right tap when latency matters and cost is justified. Webhooks are the right tap for everyone else — products that need swap/transfer-class events but can't justify a Geyser bill. The two are peers, not fallbacks: many consumers will run webhook-only; some will run both for redundancy and gap recovery.

## What you get

- **HTTP receiver.** Typed Node `http` handler. Configurable payload-size cap (default 1 MiB). HMAC verification with constant-time compare. Backpressure (saturation-aware acceptance — refuses new work above N concurrent ingests with `503` so the upstream backs off).
- **Outbox-first persistence.** The handler persists raw payload + returns `200` *before* decoding. A background drainer reads `processed_at IS NULL` rows, decodes via `@ap3x/solana-events`, emits to the signal bus, marks processed. Idempotency on `(source, helius_event_id)` — re-deliveries no-op. Backends: SQLite (dev), Postgres (production).
- **Event normalization.** Helius enhanced-transaction payloads → typed event records that match what `@ap3x/solana-events`' decoder framework emits from Geyser. Where Helius's parsing is sufficient, trust it; where it isn't (custom programs, unknown variants), fall back to raw transaction parsing through `@ap3x/solana-events`. Unknown variants surface as `UnknownEventDecode` records, never silently dropped.
- **Webhook config sync.** Typed wrapper over Helius's webhook management API: `subscribeAddresses`, `removeAddresses`, `reconcile` (idempotent diff/apply).
- **Gap catchup.** When the outbox detects a delivery gap (no events for window > threshold, or sequence-id discontinuity) or the operator triggers manually, fetch missing signatures via `@ap3x/solana-connectivity`'s historical RPC backfill, replay through decoders, mark backfilled rows with `source: 'catchup'`.
- **Healthz + metrics.** `lastEventAt()`, `isHealthy()`, structured counters/latencies surfaced through a pluggable `MetricsEmitter` interface.

## Driver contract

A `WebhookDriver` implementation is everything specific to one webhook provider. Helius is shipped; future drivers plug in by implementing:

```ts
export interface WebhookDriver {
  readonly source: string;
  verifyRequest(req: IncomingRequest): VerifyResult;
  parseRawPayload(body: Uint8Array): RawWebhookEvent[];
  normalizeEvent(raw: RawWebhookEvent): TypedSolanaEvent[];
  admin?: WebhookAdminClient;
  catchup?: WebhookCatchupClient;
}
```

## Status

This package is alpha (`0.0.x` series). The public types are stable as of `0.1.0`; outbox schema is migration-managed at `init()` so existing data is preserved across minor versions.

## Dependency posture

Same as the rest of `@ap3x/solana-*`: hand-rolled where practical, with documented exceptions. The HTTP server is built on Node's built-in `http`; HMAC verify uses Node `crypto`; JSON parsing is native. The outbox declares `better-sqlite3` and `pg` as **optional peer dependencies** — consumers who use the SQLite outbox install `better-sqlite3`; consumers who use the Postgres outbox install `pg`. Both are widely-audited, version-pinned, and only loaded via dynamic `import()` from their respective backends.

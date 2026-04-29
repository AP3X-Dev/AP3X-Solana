---
'@ap3x/solana-webhooks': minor
'@ap3x/solana-signals': minor
---

Webhook ingestion as a peer transport to Geyser, plus the multi-source signal-bus contract that ties the two together.

- **@ap3x/solana-webhooks** — initial release (alpha, `0.x` series). Ingests Solana on-chain events delivered as webhooks, normalises them to match the decoder shape `@ap3x/solana-events` produces from Geyser, and emits through the signal bus. What's shipped:
  - HTTP receiver with constant-time HMAC verification, configurable payload-size cap (default 1 MiB), and saturation-aware backpressure (default 64 in-flight; over-cap requests get `503` so the upstream backs off).
  - Outbox-first persistence: the receiver persists raw payload + returns `200` *before* decoding, so decoder bugs / schema drift / downstream consumer outages cannot lose events. Idempotency on `(source, id)` collapses re-deliveries to a no-op.
  - SQLite outbox backend (better-sqlite3, optional peer dep) — pragmas tuned for sustained write pressure (WAL + 30s busy_timeout + 64 MB cache).
  - Drainer pumps pending outbox rows through the driver's normalize step and emits each typed event through a caller-supplied callback. Failure routing distinguishes parked rows (no driver / corrupt payload) from retried rows (normalize / emit transient errors).
  - Helius driver: parses Helius's enhanced-transaction JSON envelope, normalises swap / token-mint / transfer / failed transactions to substrate-shape decoded events. Free-form `source` labels map to canonical program ids (Pump.fun, Jupiter V6, Raydium V4, fallback sentinel).
  - Healthz probe with `200/503` handler for ops tooling.
  - 89 tests, captured production fixtures included for replay-parity work.
- **@ap3x/solana-signals** — multi-source bus contract layered on top of the existing `SignalSource` / `SignalQueue` (no breaking changes). New types: `SignalProducer` (id, source, signalType, signalVersion, start, stop, health), `SignalConsumer` (id, optional signalType / versionPin / filter), `SignalBus`. New `MemorySignalBus` implementation with dedup, version-pin enforcement, predicate filtering, and per-consumer error isolation. `wrapSource` adapter turns the existing event-emitter SignalSources (Geyser, Fixture, Historical) into Producers without modifying them. `Signal.signalVersion` is now optional on the canonical record so producers can stamp the schema version they emit.

Forthcoming in subsequent releases: Postgres outbox + parity suite, Helius admin (subscribe/remove/reconcile) and catchup (gap replay), `@ap3x/pumpfun-signals` interim package.

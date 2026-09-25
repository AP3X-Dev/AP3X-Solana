# @ap3x/solana-signals

## 0.4.0

### Minor Changes

- Correctness fixes across the substrate and runtime.
  - **vault** — `signTransaction` signs the message bytes only and returns a
    valid transaction; a role with a SOL reserve must be unlocked with
    `getBalance` and `estimateDelta` (it no longer fails open).
  - **events** — `parseLogs` understands compute-unit, return-data,
    multi-field data and truncation lines (`computeUnits`, `returnData`,
    `logTruncated`); `ProgramDecoder.decodeAll` lets one invocation yield
    several events.
  - **connectivity** — historical backfill fetches the range's own
    transactions (it re-read the newest signatures before); `gapBackfill()`
    turns a Geyser gap into a backfill; `subscribe` accepts an AbortSignal;
    `getTransaction` defaults to v1 transactions.
  - **executor** — bundled intents are confirmed by their real signatures,
    `tipLamports` adds a tip transfer to `jitoTipAccount`, untipped bundles
    are rejected, submitters fail over within an attempt and track their own
    health, Jito gRPC uses TLS and sends its auth token. `SubmitPayload`'s
    bundle variant no longer has `tipLamports`.
  - **portfolio** — real unrealized PnL (`PRICE_SCALE`), realized PnL per
    mint, negative values survive persistence, cost-basis reconstruction
    replays buys and sells from where the position opened (paginated, v1,
    lookup-table aware, transfer basis via hook), `observe`,
    `rebuildPosition`, `correctLotBasis`; `Reconciler`, `writeDailyClose`
    and the accounting helpers are exported and Token-2022 balances count.
  - **strategy** — `maxLossPerDayLamports`, `drawdownThreshold` and
    `maxOpenPositions` are enforced; `onBalanceChange` fires; backtests report
    a PnL series, max drawdown, Sharpe, state snapshots and unrealized PnL.
  - **signals** — live Geyser updates are read from the correct message and
    signals carry the decoded event's kind instead of `decoded`.
  - **trading** — `toExecutorTradeIntent` returns the executor's
    `TradeIntent` type directly.

- 1f8d9a7: Initial release of the PRP-02 Solana runtime packages:
  - **@ap3x/solana-signals** — signal ingestion layer. SignalSource interface with three implementations (Fixture, Historical, Geyser), a dedup + overflow-safe SignalQueue, and durable FileSignalCheckpointStore for restart recovery.
  - **@ap3x/solana-strategy** — strategy runtime. Strategy abstract class (8-hook API), declarative SignalFilter, per-instance dispatch queue for FIFO serialization, GuardTracker for rate/loss/error limits, intentId derivation, FileStrategyStateStore, runBacktest harness (gate-6 byte-identical determinism), and the StrategyRuntime orchestrator wiring signals → strategies → executor → portfolio.
  - **@ap3x/solana-executor** — decision → on-chain. Executor.submit with idempotency (InFlightMap), compute-budget telemetry, vault-mediated signing (resolveWallet seam), three submitters (RpcSubmitter, JitoHttpSubmitter, JitoGrpcSubmitter with vendored protos), BundleAccumulator (50ms / 5 intent window), failover chain with fee-tier bump progression, and uniform ExecutionResult envelope.
  - **@ap3x/solana-portfolio** — position + cost-basis tracking. FilePortfolioStore with FIFO reduction + atomic tmp+rename, SwapTracerRegistry for per-venue trade classification, CostBasisReconstructor for cold-start wallet recovery, Reconciler for drift detection, daily-close append-only writer, and `ap3x-portfolio correct-basis` CLI.

  All four packages share the substrate posture: zero runtime deps on `@solana/web3.js`, `@solana/spl-token`, `@metaplex-foundation/*`. Only `@noble/ed25519` + `libsodium-wrappers` permitted.

- 213e80f: Webhook ingestion as a peer transport to Geyser, plus the multi-source signal-bus contract that ties the two together.
  - **@ap3x/solana-webhooks** — initial release (alpha, `0.x` series). Ingests Solana on-chain events delivered as webhooks, normalises them to match the decoder shape `@ap3x/solana-events` produces from Geyser, and emits through the signal bus. What's shipped:
    - HTTP receiver with a constant-time shared-secret check on the `Authorization` header (the Helius scheme; no body HMAC), configurable payload-size cap (default 1 MiB), and saturation-aware backpressure (default 64 in-flight; over-cap requests get `503` so the upstream backs off).
    - Outbox-first persistence: the receiver persists raw payload + returns `200` _before_ decoding, so decoder bugs / schema drift / downstream consumer outages cannot lose events. Idempotency on `(source, id)` collapses re-deliveries to a no-op.
    - SQLite outbox backend (better-sqlite3, optional peer dep) — pragmas tuned for sustained write pressure (WAL + 30s busy_timeout + 64 MB cache).
    - Drainer pumps pending outbox rows through the driver's normalize step and emits each typed event through a caller-supplied callback. Failure routing distinguishes parked rows (no driver / corrupt payload) from retried rows (normalize / emit transient errors).
    - Helius driver: parses Helius's enhanced-transaction JSON envelope, normalises swap / token-mint / transfer / failed transactions to substrate-shape decoded events. Free-form `source` labels map to canonical program ids (Pump.fun, Jupiter V6, Raydium V4, fallback sentinel).
    - Healthz probe with `200/503` handler for ops tooling.
    - 89 tests, captured production fixtures included for replay-parity work.
  - **@ap3x/solana-signals** — multi-source bus contract layered on top of the existing `SignalSource` / `SignalQueue` (no breaking changes). New types: `SignalProducer` (id, source, signalType, signalVersion, start, stop, health), `SignalConsumer` (id, optional signalType / versionPin / filter), `SignalBus`. New `MemorySignalBus` implementation with dedup, version-pin enforcement, predicate filtering, and per-consumer error isolation. `wrapSource` adapter turns the existing event-emitter SignalSources (Geyser, Fixture, Historical) into Producers without modifying them. `Signal.signalVersion` is now optional on the canonical record so producers can stamp the schema version they emit.

  Forthcoming in subsequent releases: Postgres outbox + parity suite, Helius admin (subscribe/remove/reconcile) and catchup (gap replay), `@ap3x/pumpfun-signals` interim package.

### Patch Changes

- Updated dependencies
  - @ap3x/solana-events@0.4.0
  - @ap3x/solana-connectivity@0.4.0
  - @ap3x/solana-core@0.4.0

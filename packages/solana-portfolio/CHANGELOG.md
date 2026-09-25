# @ap3x/solana-portfolio

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

### Patch Changes

- Updated dependencies
  - @ap3x/solana-events@0.4.0
  - @ap3x/solana-connectivity@0.4.0
  - @ap3x/solana-spl@0.4.0
  - @ap3x/solana-core@0.4.0

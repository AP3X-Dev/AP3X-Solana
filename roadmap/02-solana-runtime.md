# PRP-02 — Solana runtime (signal → strategy → execute → track)

**Repo:** `ap3x-solana/` (continues from PRP-01)
**Depends on:** PRP-01 substrate (merged to main, all 7 packages shipped)
**Unblocks:** any Solana-venue vertical (pump.fun, Raydium, Orca, Jito, Magic Eden) — each becomes a thin decoder + optional venue-specific tx builder on top of this runtime, not a duplicated pipeline.
**Supersedes:** the prior `roadmap/02-pumpfun-protocol.md` is re-sequenced to PRP-03 (pump.fun becomes the first vertical validating this runtime, not the first thing built).
**Estimate:** 3-4 weeks solo (cost-basis reconstruction, lifecycle-aware strategy API, and Jito gRPC block-engine all ship from day one — no "upgrade later" deferrals)

## Goal

Ship `@ap3x/solana-signals`, `@ap3x/solana-strategy`, `@ap3x/solana-executor`, `@ap3x/solana-portfolio` — the **venue-agnostic runtime** that sits between the substrate and any future vertical. Decoded events flow in as signals; strategies consume signals and emit decisions; the executor assembles+signs+submits transactions; the portfolio layer tracks positions and PnL.

After PRP-02, adding a new venue means writing a decoder (already registered via `@ap3x/solana-events`) plus optional venue-specific transaction builders. It does **not** mean re-implementing signal routing, strategy dispatch, execution retry, position tracking, or PnL accounting. Each vertical inherits those for free.

This PRP establishes the runtime as its own publishable asset. A team building a vertical-less Solana agent (e.g., "watch SPL transfers for a whale list and alert") gets a complete product out of `@ap3x/solana-*` with zero vertical code.

## In scope

### Package `@ap3x/solana-signals`

Normalized event stream. Ingests from any source (live Geyser, historical RPC backfill, replay fixture), emits typed `Signal` records into a bounded queue with dedup and ordering guarantees.

- **`Signal` shape** — `{ signalId, ts, slot, signature, programId, kind, venue, decoded, raw }`. `signalId` is deterministic from `(signature, programId, kind, logIndex)` so the same on-chain event produces the same ID regardless of source.
- **`SignalSource` interface** — `start()`, `stop()`, `.on('signal', …)`, `.on('gap', …)`. Three implementations ship:
  - `GeyserSignalSource({ geyserClient, decoderRegistry, programIds })` — wraps `@ap3x/solana-connectivity`'s `GeyserClient` + `@ap3x/solana-events`'s `EventDecoderRegistry`.
  - `HistoricalSignalSource({ rpcPool, decoderRegistry, programIds, slotRange })` — walks historical slots lazily via `RpcHistoricalBackfill`.
  - `FixtureSignalSource({ path })` — replays a captured `.jsonl.gz` of Signals for deterministic backtesting.
- **`SignalQueue`** — bounded in-memory queue with drop-oldest on overflow + dedup by `signalId` over a configurable window. Subscribers pull; producers push.
- **`SignalCheckpointStore`** — persists last-processed `signalId` + slot per subscriber name. Restart recovery resumes from checkpoint; never re-delivers acknowledged signals.
- **Unknown-variant channel** — `UnknownEventDecode` records flow through as structured `{ kind: 'unknown', programId, reason }` signals — never silently dropped (re-uses the pattern from `@ap3x/solana-events`).

### Package `@ap3x/solana-strategy`

Class-based strategy runtime with lifecycle hooks. Strategies are the core value-add of the whole platform — the API is designed from day one to support complex stateful strategies, not trivial one-signal-one-decision handlers. A structured DSL is a future PRP; this PRP's API is class-based TypeScript, callable from that future DSL's compiled output.

- **`Strategy` abstract class** with the following hooks (all optional except `onSignal` + `name` + `filters`):
  ```ts
  abstract class Strategy {
    abstract readonly name: string;
    abstract readonly filters: SignalFilter[]; // declarative: which programIds/venues/kinds to receive

    // Lifecycle — called once per strategy-instance lifetime
    onStart?(ctx: StrategyContext): Promise<void>;     // load persisted state, warm caches, sanity checks
    onShutdown?(ctx: StrategyContext): Promise<void>;  // flush state, close connections

    // Event hooks
    abstract onSignal(signal: Signal, ctx: StrategyContext): Promise<Decision | null>;
    onExecutionResult?(result: ExecutionResult, ctx: StrategyContext): Promise<void>;
    onPositionChange?(change: PositionChange, ctx: StrategyContext): Promise<void>;
    onBalanceChange?(wallet: string, deltas: BalanceDelta[], ctx: StrategyContext): Promise<void>;
    onTick?(tsMs: number, ctx: StrategyContext): Promise<void>;  // configurable heartbeat, default 1s

    // Error handling — called on any uncaught hook error; default logs + trips kill-switch
    onError?(err: Error, phase: string, ctx: StrategyContext): void;
  }
  ```
- **`StrategyContext`** — read-only access surface:
  - `portfolio: PortfolioReadApi` — current positions, realized PnL, cost basis lookups
  - `vault: VaultReadApi` — wallet handles by name/role, addresses (never raw keys)
  - `state: StrategyStateStore` — persistent key-value store scoped per strategy instance, JSON-file backed by default, atomic writes (survives restarts)
  - `metrics: MetricsEmitter` — typed emitter shared with the substrate's metrics channel
  - `priceSource?: PriceSource` — optional registered price oracle (e.g., Pyth wrapper, Birdeye wrapper, Jupiter price API wrapper — caller-provided, not shipped in this PRP)
  - `now(): number` — injectable clock for deterministic testing and backtest replay
  - `logger: Logger` — structured logger tagged with strategy name
- **Strategy instantiation** — `new MyStrategy(config)` with strategy-author-defined config. Multiple instances of the same class with different configs are supported (e.g., two copy-trading strategies watching different whales). Each instance gets its own `StrategyContext` with isolated `state`.
- **Concurrent-signal handling per strategy** — signals dispatched to a single strategy instance are serialized (queued and awaited). Different strategy instances run concurrently. This keeps strategy authors from dealing with in-strategy race conditions while still parallelizing across the fleet.
- **`StrategyRuntime`** — orchestrator that registers strategies, matches signals via filters, dispatches, collects Decisions, emits to the executor. Handles lifecycle (calls `onStart` on registration, `onShutdown` on deregistration), error isolation (one strategy crash never affects others), and the per-strategy serialization described above.
- **Idempotency** — each Decision carries an `intentId` derived from `(signalId, strategyName, strategyInstance, decisionVersion)`. Downstream executor uses this as the submit-dedup key.
- **Backtest harness** — `runBacktest({ strategy, fixtureSource, portfolioStartState, clock })` returns `BacktestResult { trades, pnl, maxDrawdown, sharpe, decisionLog, stateSnapshots }`. Same dispatch path as live; executor substitutes a **simulated executor** (decisions logged + simulated landing with configurable success/failure rates, no real tx). Deterministic `clock` + seeded randomness lets a backtest replay identically across runs.
- **Strategy guards** — per-strategy limits enforced by the runtime: max decisions/minute, max open positions, max loss/day, kill-switch on error threshold or drawdown threshold. Tripping a guard emits a structured `strategy.tripped` metric AND calls `onShutdown` to let the strategy flush state cleanly before the runtime refuses further dispatches until manually re-enabled.

### Package `@ap3x/solana-executor`

Decision → signed transaction → submission → tracked result. Wraps `@ap3x/solana-tx` + `@ap3x/solana-vault` + `@ap3x/solana-connectivity`. Designed to be enterprise-ready from day one — both HTTP and gRPC block-engine submission paths ship together, with a clean interface seam so additional submitters (e.g., searcher-direct endpoints) plug in without executor changes.

- **`TradeIntent` shape** — venue-agnostic payload: `{ intentId, wallet: string, instructions: Instruction[], altHints?: PublicKey[], feeTier: FeeTier, computeBudgetHint?: number, deadline: number, submitter?: SubmitterHint }`. Strategies produce intents; the executor has no notion of "buy" vs "sell" — those are encoded in the instructions.
- **`Executor.submit(intent): Promise<ExecutionResult>`** — pulls `WalletHandle` from vault, runs `computeBudget.simulateAndBudget`, picks priority fee via `PriorityFeeEstimator.tier(feeTier)`, assembles v0 tx via `TransactionAssembler`, routes to the submitter indicated by `submitter` hint (defaults to the configured primary). Polls for landing up to `deadline`. Returns `{ kind: 'landed' | 'dropped' | 'timeout' | 'reverted' | 'rejected', signature?, slot?, submitterUsed, error? }`.
- **`Submitter` interface** — `{ name, kind: 'rpc' | 'jito-http' | 'jito-grpc' | 'custom', submit(signed: Uint8Array | Bundle): Promise<SubmissionAck> }`. Executor holds an ordered list of submitters; routes per intent. Three implementations ship:
  - **`RpcSubmitter`** — plain `sendTransaction` via `RpcPool.pinForWrite()`. Default for standard single-tx intents.
  - **`JitoHttpSubmitter`** — Jito block-engine REST endpoint (`/api/v1/bundles`). Uses `@ap3x/solana-tx`'s `JitoBundleBuilder` for composition; this package adds the network layer.
  - **`JitoGrpcSubmitter`** — Jito searcher-service gRPC direct against the block engine. Vendors `searcher.proto` + `bundle.proto` from `jito-labs/mev-protos` (pinned commit hash in header comment, same pattern as T14's Yellowstone vendoring). Uses the existing `@grpc/grpc-js` + `@grpc/proto-loader` deps that are already in the workspace. Lower latency than HTTP, required for enterprise searcher setups.
- **Submitter routing policy** — per-intent hint selects a submitter class; executor picks the first healthy instance of that class. If no healthy submitter matches, falls back through a configurable preference chain. Failover is automatic within 1 attempt.
- **Bundle composition** — multiple intents can opt into bundling by sharing a `bundleGroup` id; executor gathers them within a small time window (configurable, default 50ms), composes via `JitoBundleBuilder`, submits via the selected Jito submitter. Max 5 intents per bundle (Jito protocol limit, already enforced by `JitoBundleBuilder`).
- **Idempotency** — before submit, checks an `in-flight` map by `intentId`. Duplicate submit returns the prior result without re-executing. `in-flight` entries expire on terminal result.
- **Retry policy** — configurable per intent: on `dropped` retry up to N times with bump-fee-tier progression (low → med → high → turbo), each attempt logged. On `timeout` with no landing, caller decides (strategy receives `ExecutionResult`, may re-issue).
- **Vault integration** — refuses to submit if `WalletHandle.signTransaction` throws `WalletReserveBreach`; surfaces as `rejected` with code `reserve_breach`. Same path for any other vault-side rejection (passphrase policy, locked wallet, etc.).

### Package `@ap3x/solana-portfolio`

Position + PnL tracking. Watches executor outcomes AND vault-owned wallet balance deltas (via `getTokenAccountsByOwner` polling or Geyser subscription) to maintain a full account of current holdings. **Accurate PnL from day one — no manual cost-basis correction required.**

- **`Position` shape** — `{ mint, walletAddress, lots: Lot[], lastUpdatedSlot }` where `Lot = { amount: bigint, costBasisLamports: bigint, acquiredSlot, acquiredSig, source: 'trade' | 'airdrop' | 'transfer-in' | 'cold-start-reconstructed' | 'cold-start-unresolved' }`. Per-lot tracking enables FIFO / LIFO / avg-cost accounting without storing aggregates.
- **`PortfolioStore`** interface — `getPosition(wallet, mint)`, `getAllPositions(wallet)`, `applyExecutionResult(result)`, `observe(wallet)` (begins tracking including cold-start reconstruction). File backend default (JSON per wallet in `.ap3x/portfolio/`), pluggable for Postgres/SQLite later.
- **Cost-basis reconstruction (cold start)** — when a wallet is first observed with a non-zero token balance, the portfolio walks history via `@ap3x/solana-connectivity`'s `RpcHistoricalBackfill` to derive real cost basis from on-chain truth:
  1. `iterateSignaturesForAddress` back from current slot until either the wallet has zero balance for the target mint OR a configurable lookback limit (default 90 days) is hit.
  2. For each transaction, fetch meta, extract pre/post token balances for the target mint, correlate with SOL outflows from the same wallet in the same tx.
  3. Classify each inbound lot:
     - **Trade** (SOL outflow paired with token inflow) — cost basis = SOL outflow.
     - **Airdrop / mint** (token inflow with zero SOL outflow, no matching token outflow elsewhere) — cost basis = 0.
     - **Transfer-in** (from another vault-tracked wallet) — inherit cost basis from the source wallet's corresponding outflow lot; if source wallet not tracked, cost basis = 0 with `source: 'transfer-in'`.
     - **Swap via known DEX** (token inflow from Raydium/Orca/Jupiter/pump.fun program signatures) — reconstruct by tracing the outbound SOL/token leg through the swap instruction; if the DEX isn't recognized by a registered swap-tracer plugin, fall back to SOL-outflow heuristic.
  4. If reconstruction hits the lookback limit with remaining un-accounted balance, emit a `cost-basis-incomplete` event naming the wallet + mint + un-accounted amount; the lot is stored as `source: 'cold-start-unresolved'` with `costBasisLamports: 0` AND a `reconstructedAt` timestamp so a user can manually correct it via a CLI tool. Reducing an unresolved lot emits a `realized-pnl` event flagged `basisUnresolved: true` so dashboards can visually distinguish it.
- **`SwapTracer` interface** — plug-in point for venue-specific swap decoders to help reconstruct cost basis accurately. PRP-02 ships with a minimal tracer for plain SPL transfers; pump.fun (PRP-03) registers its tracer against this interface, and every future vertical PRP adds one. Verticals without tracers degrade gracefully to the SOL-outflow heuristic.
- **Cost-basis accounting method** — **FIFO default** (US-retail tax-friendly); LIFO and avg-cost selectable per wallet via config. The per-lot storage means switching methods is a read-side concern, not a data migration.
- **PnL events** — `'realized-pnl'` when a position is reduced (carries `{ realized, costBasis, proceeds, basisUnresolved }`); `'unrealized-pnl'` computed on-demand by `getUnrealizedPnl(wallet, mint, currentPriceLamports)`. USD conversion is still caller's layer (price source variance), but lamport-denominated PnL is always available.
- **Reconciliation** — periodically compares stored positions against on-chain balances; any drift emits a `portfolio.drift` event with deltas. Drift indicates either a missed execution result or an external transfer; the runtime surfaces the discrepancy and triggers an incremental re-reconstruction of the drifted mint so PnL stays correct.
- **Daily close** — optional scheduled job that freezes a day's positions + realized PnL into append-only `.ap3x/portfolio/<wallet>.daily.jsonl`. Useful for audit + tax export.
- **CLI correction tool** — `pnpm portfolio correct-basis <wallet> <mint> <lotIndex> <costBasisLamports>` for the rare case a user needs to manually fix a reconstructed lot (e.g., OTC transfer with known off-chain price). Every manual correction is logged to the audit trail.

### Example app `examples/spl-watcher/`

**Zero venue-specific code.** Watches SPL Token transfers to a configurable list of wallets; when one hits, emits a structured JSON-line event. This is the dogfood for the runtime — proves the full signal → strategy → (no execute) path works against a boring, well-understood protocol before any vertical lands.

- ~150 LOC total
- Registers a built-in "SPL Token transfer" decoder (extracts `from`, `to`, `amount` from token program logs)
- One strategy: "alert if recipient is in my wallet list"
- No execution leg — proves signal routing in isolation
- Runnable against a fixture for zero-dollar CI; against live Helius RPC (historical mode) for manual verification

## Out of scope

- **Venue-specific decoders** — pump.fun becomes PRP-03. Raydium, Orca, Jupiter, Magic Eden become their own PRPs, each thin enough to land in 1-2 weeks each now that the runtime exists. Each vertical registers a `SwapTracer` alongside its event decoder so cost-basis reconstruction improves automatically as verticals land.
- **Strategy DSL** — class-based TypeScript API in this PRP. A structured DSL with parameter sweeps + genetic tuning belongs to a later PRP once we have 3+ strategies and a DSL compiler's emitted code can target the class-based API from this PRP without a shim layer.
- **Multi-process / distributed runtime** — single-process MVP. Horizontal scale is a separate concern.
- **UI / dashboard** — library + CLI only. Frontends are downstream.
- **Live mainnet acceptance against actual trading** — no Business-tier Geyser, so live mainnet tests are backlog-gated. The MVP acceptance uses historical-backfill mode + fixture replay.
- **USD price oracles** — portfolio reports lamports; USD conversion is caller's layer. Cost basis in lamports is accurate and sufficient for ratio-based PnL (percent return), which is what strategies actually consume.
- **Cross-chain** — `@ap3x/solana-*` stays Solana-specific. Chain-agnostic extraction happens when Hyperliquid forces it (per roadmap).

## Deliverables

1. Four new packages workspace-published: `@ap3x/solana-signals`, `-strategy`, `-executor`, `-portfolio`.
2. Example app `examples/spl-watcher/` demonstrating the runtime end-to-end against fixture + historical RPC.
3. Updated root `package.json` devDep references and boundary rules in `eslint.config.mjs`.
4. Test suite:
   - Unit tests per package, 80%+ coverage
   - Integration test: fixture replay → signal → strategy → simulated executor → portfolio update → assert PnL
   - End-to-end: devnet SPL transfer → signal → strategy match (no execute leg) → check log output
5. Documentation: README per package; `docs/runtime-architecture.md` explaining the signal→strategy→execute→track flow with sequence diagrams; migration notes for future verticals ("how to plug pump.fun into this runtime").
6. CI: runtime tests added to the existing Ubuntu + Windows matrix; forbidden-dep checks already enforced via T35 inheritance.

## Acceptance criteria (gate)

1. **End-to-end signal round-trip**: a fixture `.jsonl.gz` of 100 Signals replays through `FixtureSignalSource` → `StrategyRuntime` → simulated `Executor` → `PortfolioStore` with zero lost signals, zero duplicate decisions, final portfolio state matches expected.
2. **Idempotency**: same signal delivered twice (fixture replay run twice) produces exactly one execution-result record in the simulated executor.
3. **Restart recovery**: crash the runtime mid-stream (SIGKILL after 50 signals), restart, verify no duplicates and no gaps from the `SignalCheckpointStore`. `StrategyStateStore` survives the crash with no corruption.
4. **Vault integration**: executor refuses to submit an intent whose simulated result would breach the wallet's SOL reserve; emits `rejected` with `reserve_breach` code.
5. **Provider failover**: kill the primary RPC in a test `RpcPool` mid-execution; executor continues on the backup without losing the in-flight intent.
6. **Backtest parity**: running a strategy live against a devnet SPL transfer stream and running the same strategy in backtest mode over the captured fixture of those same transfers produces identical decision logs AND identical lifecycle-hook call sequences.
7. **Portfolio drift detection + re-reconciliation**: inject an external transfer (manually simulated) into a tracked wallet; the reconciler surfaces the drift within 1 cycle AND runs incremental cost-basis reconstruction so the next `getPosition` returns correct lots.
8. **Cost-basis reconstruction accuracy**: against one of the captured mainnet fixtures from PRP-01 B6 (`tests/fixtures/spl-accounts.json.gz`), pick 10 wallets with known trade history, reconstruct their SPL positions, and verify each reconstructed lot's cost basis matches the actual SOL outflow from the corresponding historical transaction within ±1 lamport (the tolerance is for rent-exempt minimum dust).
9. **Jito submission parity**: both `JitoHttpSubmitter` and `JitoGrpcSubmitter` submit the same bundle input and receive structurally-equivalent acknowledgments (bundle UUID, tip-account assignment, landed slot). Tested against in-process gRPC fake (same pattern as T14) + HTTP mock.
10. **Strategy lifecycle fidelity**: a test strategy with all 8 hooks implemented receives each hook exactly as spec'd: `onStart` once on registration, `onSignal` per matching signal, `onExecutionResult` per submitted intent's outcome, `onPositionChange` per portfolio update, `onBalanceChange` per observed delta, `onTick` at configured interval, `onError` on injected exceptions, `onShutdown` once on deregistration.
11. **Zero ecosystem deps** — same policy as PRP-01, CI-enforced via the existing `pnpm why` check.
12. **Coverage**: 80%+ on packages, 60%+ on the example.
13. **Boundary enforcement**: `eslint-plugin-boundaries` rules extended to keep verticals (future) from reaching around the runtime directly into substrate internals.

## Key design decisions

- **Venue-agnostic signal shape.** `Signal` does not have pump.fun-specific fields, Raydium fields, or anything else vertical. A `kind` string + `decoded` payload (typed per vertical's decoder) carries all vertical flavor. This is the pattern that lets Raydium/Orca/Magic Eden land as thin decoders later.
- **Intent-based execution, not instruction-based strategy.** Strategies emit `TradeIntent` (wallet, instructions, fee tier, deadline). They do NOT emit "buy pump.fun token X for N SOL" — that framing would re-couple the strategy to a specific venue. Instead, a venue's SDK exports a helper that builds the instruction list; the strategy calls the helper then hands the output to the executor.
- **Class-based strategy API with lifecycle hooks from day one.** Strategies are the core value-add of the platform. The API ships with `onStart` / `onShutdown` / `onSignal` / `onExecutionResult` / `onPositionChange` / `onBalanceChange` / `onTick` / `onError` hooks, per-instance persistent state, and isolated contexts — not as retrofits in a later PRP. Deferring these to "v2" would force strategy authors to work around missing primitives and couple them to the runtime's internals.
- **Accurate cost basis from day one via on-chain reconstruction.** When the portfolio first observes a wallet, it walks signature history to derive real cost basis per lot — not zero-with-a-manual-correction-requirement. FIFO default, LIFO and avg-cost selectable. Per-lot storage keeps the method a read-side concern. Un-reconstructable lots (older than lookback, unrecognized swap venues) surface explicitly as `cold-start-unresolved` so users know which PnL numbers to treat as provisional.
- **Both Jito submission paths ship together.** `JitoHttpSubmitter` (block-engine REST) and `JitoGrpcSubmitter` (searcher-service gRPC direct, vendored proto) are both in this PRP. Enterprise-grade searcher setups need gRPC latency; deferring it invites a retrofit later that breaks caller code. The `Submitter` interface seam keeps them pluggable and lets additional submitters (e.g., direct-to-validator relays) slot in without executor changes.
- **Backtest and live share the dispatch path.** The only swap is the signal source (fixture vs Geyser) and the executor (simulated vs real). This guarantees backtest vs live parity — a strategy that wins in backtest cannot silently misbehave live due to different code paths. Strategy lifecycle hooks fire identically in both modes.
- **Idempotency by construction.** Every Signal has a deterministic `signalId`. Every Decision has a deterministic `intentId` derived from signal + strategy + instance + version. Every submit dedupes on `intentId`. Re-delivery is always safe.
- **File-backed stores as default, but serious from day one.** `SignalCheckpointStore`, `PortfolioStore`, and `StrategyStateStore` all default to file backends (mirroring `FileVaultStorage` + `FileCheckpointStore` from PRP-01) with atomic writes and per-key locking. No database required to run. The interface is the same one Postgres/SQLite adapters plug into later without touching call sites.
- **Drift surfaces AND triggers re-reconciliation.** The portfolio layer flags discrepancies AND re-runs incremental cost-basis reconstruction for the drifted mint so subsequent PnL stays correct. Auto-correction is limited to what on-chain history can resolve; unexplained drift stays surfaced for the user to investigate.
- **Single-process MVP.** No multi-worker signal dispatch, no distributed queue. Complexity is earned later if single-process throughput becomes a bottleneck.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Strategy authors will want a DSL sooner than we think | Class-based TypeScript API is DSL-target-compatible from day one; a future DSL compiler emits code against these hooks. No retrofit required. |
| Live mainnet streaming acceptance requires paid Geyser | Devnet streaming + historical-backfill + fixture replay cover 90% of the pipeline validation. Mainnet live acceptance goes to backlog alongside PRP-01 B1/B3/B4/B5. |
| Jito gRPC protocol churn (proto versions, searcher-auth changes) | Vendor `searcher.proto` with pinned commit hash + license attribution (same pattern as T14's Yellowstone vendoring); document rev process in `docs/CONTRIBUTING.md`. Changes to proto surface in a PR, not a silent runtime break. |
| Portfolio drift could mask a real bug vs. normal external activity | All drift events carry context (wallet, mint, expected vs observed, last-known-landed-sig); incremental reconstruction auto-corrects what on-chain history resolves; unexplained drift stays surfaced. |
| Cost-basis reconstruction is RPC-expensive | Lookback default of 90 days; configurable per wallet. Reconstruction runs on `observe()` once per wallet, not per signal. Results cache in the PortfolioStore so restarts don't re-walk. Rate-limiting + backoff against the RpcPool already in substrate. |
| Swap-tracer coverage gaps (token received via unrecognized DEX) | Graceful degradation to SOL-outflow heuristic + `cost-basis-incomplete` event surfaces gaps visibly. Each vertical PRP ships its own `SwapTracer`, so coverage grows with the platform. CLI correction tool handles the rare manual case. |
| Strategy hook complexity (new authors overwhelmed by 8 hooks) | Only `name`, `filters`, `onSignal` are required. Documentation + examples lead with a minimal strategy; advanced hooks are opt-in. |
| Per-strategy state persistence corruption on crash | `StrategyStateStore` uses atomic tmp+rename writes + per-key locking (same pattern as `FileVaultStorage` T11 hardening). Tested with kill-mid-write injection. |

## Next

On gate pass:
- **PRP-03 (pump.fun protocol)** unlocks — now a thin decoder + venue-specific instruction builders registered against this runtime, not a duplicate pipeline.
- **Any other vertical PRP** (Raydium, Orca, Jupiter, Magic Eden, Jito) unlocks independently, each estimated at 1-2 weeks solo thanks to the runtime doing the heavy lifting.
- **Non-vertical products** (whale watcher, portfolio dashboard, token inspector, NFT auditor, etc.) become buildable as thin apps on top of `@ap3x/solana-*` — no vertical code required.

## Alternative products enabled by this runtime

These don't need a vertical decoder at all — they ship as pure runtime applications:

1. **Wallet portfolio tracker** — portfolio store + balance reconciliation; no execution leg.
2. **Whale activity alerter** — signal source over SPL Token program filtered to watched addresses; strategy emits Telegram/Discord payloads; no executor.
3. **Historical event indexer** — historical signal source + decoder registry → Postgres/SQLite dumper. Cold-storage archive of decoded events.
4. **RPC/Geyser drift monitor** — uses diag probes on cron + alert on threshold breaches; no strategy or execution.
5. **Self-custody treasury manager** — vault + portfolio + executor (manual intent submission via CLI, not strategy-driven).
6. **Rug-pull scanner** — historical signal source + one-shot analysis strategy that emits reports; no executor.
7. **Airdrop tool** — executor only (manual intent list from CSV); no signals or strategy.
8. **Fee tier oracle** — priority-fee estimator (already in substrate) wrapped as a JSON HTTP server; executor-adjacent, no strategy.

Each of these is 1-3 days of work on top of PRP-02. Pump.fun (PRP-03) is more complex than any of them and doesn't need to be first.

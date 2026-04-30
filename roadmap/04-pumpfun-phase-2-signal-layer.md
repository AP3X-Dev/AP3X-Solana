# PRP-04 — Pump.fun vertical, Phase 2: Signal layer + backtest harness

**Repo:** `ap3x-solana/` (continues from PRP-03)
**Depends on:** PRP-03 (live execution)
**Unblocks:** PRP-05 (platform extraction), PRP-08 (strategy runtime)
**Estimate:** 4 weeks solo
**Master spec:** [00-master-platform-prp.md §6.4, §8](./00-master-platform-prp.md)

## Status

A **v0 sqlite-backed signal API** shipped under `@ap3x/pumpfun-signals` 0.1.x as an interim slice ahead of the full Phase-2 build. It exposes the `PumpfunSignals` interface (`getToken`/`getHolders`/`getTrades`/`getCandles`/`newMintStream`) backed by a `SqlitePumpfunSignals` reference implementation with strict `asOf` enforcement (validated by a 10k-query fuzz). This is not the final event-sourced layer described below — it deliberately uses sqlite over the eventual Parquet + DuckDB stack so that downstream strategy work can be unblocked while the larger ingestion pipeline lands. The API surface is forward-compatible: when the Parquet/DuckDB backend ships, it implements the same `PumpfunSignals` interface and consumers swap implementations without code changes.

## Goal

Build the **signal layer** — the intelligence that distinguishes the platform from "anyone can call RPC." Event-sourced storage (Parquet + DuckDB), base signals (token, holders, trades, candles, new-mint streams), derived signals that are the strategic moat (dev reputation, smart money flow, wallet tagging, bundle detection, graduation ETA), and the **backtest harness** with virtual-clock replay and realistic fill modeling.

Signal layer is the **moat**. Anyone can call RPC; not everyone has clean, versioned, time-indexed derived intelligence on every pump.fun wallet and mint. This PRP builds the first iteration of that moat for pump.fun — and establishes the framework pattern that Hyperliquid and every future vertical will plug into.

## In scope

### Package `@ap3x/pumpfun-event-store` (new)

- **Storage** — Parquet on object storage (S3/R2 for prod; local filesystem for dev), partitioned by `date`. Columns: `slot`, `block_time`, `signature`, `program_id`, `event_type`, `payload` (typed), `ingest_time`, `source_kind` (`on-chain` | `off-chain`). Immutable, append-only. Schema versioned.
- **Off-chain signal source** — pump.fun's `advanced-api-v2.pump.fun` (trending feeds, creator history, comment counts) and `frontend-api-v3.pump.fun` (single-token detail) ingest as first-class signals here, not as a standalone compat package. Typed client with drift-tolerant parsing; polling cadence configurable per endpoint; captured payloads land in the event store with `source_kind: 'off-chain'` and share the same time-indexing + backtest semantics as on-chain events. This re-homes what was originally scoped as `@ap3x/pumpfun-compat` in PRP-02.5 — off-chain-data-as-a-standalone-package was the wrong architecture; strategies, research tools, and consumer apps (Chad when rebuilt in PRP-12) read both through the signal-layer interface.
- **Hot index** — DuckDB view over Parquet for signal queries. Query latency target: p95 < 100ms for time-windowed scans on 30 days of data.
- **Live tap** — Geyser stream (from PRP-01) writes to local DuckDB first, batches to Parquet every N slots. Live-to-queryable lag < 2s.
- **Historical backfill** — one-time ingest of pump.fun program history (Helius RPC Enhanced APIs or equivalent). Runs against archive once, commits to cold storage.
- **Schema migrations** via view layer — new derived columns add as computed views, not rewrites. Backwards-compatible until explicit retention cutoff.
- **Performance target** — one year of pump.fun in < 500 GB compressed Parquet.

### Package `@ap3x/pumpfun-signals` (new)

**Base signals** (cheap, direct from event store):

- `getToken(mint, asOf)` — metadata, curve state, price, graduation %, liquidity, authorities at virtual time `asOf`
- `getHolders(mint, asOf, limit)` — top N holders, concentration (Herfindahl-Hirschman Index), % held by wallets < 24h old
- `getTrades(mint, asOf, window)` — recent trades with wallet tags (produced by wallet_tag derived signal)
- `getCandles(mint, asOf, interval, count)` — OHLCV derived from trades
- `newMintStream(since, filter)` — subscription (live) or bounded query (backtest) of new token creations

**Derived signals** (the moat):

- `devReputation(wallet, asOf)` — features: prior mint count, rug rate, graduation rate, median peak mcap, median time-to-peak, funding-source cluster id, first-seen age. v1 scoring: deterministic weighted sum (documented); v2 (PRP-08+): learned model. Version pinned per query.
- `walletTag(wallet, asOf)` — multi-label: `dev`, `sniper`, `kol`, `insider`, `fresh`, `whale`, `rugger_history`, `graduated_dev`. Derived from historical behavior, retrained on the event store periodically, version pinned.
- `smartMoneyFlow(mint, asOf, window)` — net SOL flow from wallets with historical profitability above threshold. Profitability computed on the event store itself.
- `bundleDetection(mint, slot)` — same-block coordinated buys (likely sniper bundles) via wallet-cluster analysis. Returns wallet groups + confidence score.
- `correlation(mint, asOf, window)` — other mints moving in lockstep (coordinated pump detection)
- `graduationETA(mint, asOf)` — estimated time + probability + confidence; composite of curve progress rate + historical graduation-vs-rug base rate for similar-profile tokens
- `priceImpact(mint, solAmount)` — pure curve math (from PRP-02) surfaced as a signal for sizing decisions

**As-of enforcement** — every signal query takes an `asOf` timestamp. Queries return only events with `observed_at <= asOf`. Enforced at the query layer, not by convention. Fuzz test in CI verifies no query returns post-`asOf` rows. This is what makes backtests honest.

**Versioning** — every derived signal has a `signal_version`. Backtests pin versions. Upgrades run in shadow mode against prior version before rollout. Strategies can declare minimum signal version in their config.

### Package `@ap3x/pumpfun-backtest` (new — will extract to `@ap3x/backtest` in PRP-05)

- **Virtual clock** — single monotonic clock, advanced by event. All signal queries take implicit `asOf = clockNow`. Strategy callbacks fire with event timestamp as clock. No wall-time access for strategies during backtest.
- **Fill simulator** — given a simulated submission at clock T with size S, slippage B, priority fee tier P:
  1. Sample latency L from live-calibrated distribution: effective submit = T + L
  2. Look up curve state at T + L from event history
  3. Compute expected fill
  4. Check real on-chain activity in the slot window:
     - Competing buys → probability reduction proportional to tier
     - Curve moved beyond B → `failed_slippage`
     - Revert events → `failed_revert`
  5. Outcomes: `filled`, `failed_slippage`, `failed_revert`, `landed_late`
- **Calibration source** — 30 days of live platform execution from PRP-03 live run. Bootstrap defaults until calibrated: 50% worse slippage than naive, 20% failure rate on contested new mints, latency mean 400ms / p99 1.5s.
- **Determinism** — same `(strategy_version, policy_version, signal_versions, date_range, initial_capital_sol, fill_model, seed)` tuple → bit-identical outputs. Regression test in CI.
- **Output** — PnL timeseries, trade ledger, attribution by signal / dev bucket / hour, comparison API, replay API for debugging.
- **Performance** — declarative strategy 1 day / 30s, 1 month / 15 min. Agentic (Opus 4.7) 1 day / 10 min with response cache.

### Paper mode (runs alongside live in PRP-03's wallet — same code path, different submit endpoint)

- `submit_tx` in paper mode records the receipt + expected outcome to the audit log WITHOUT calling the Jito bundle dispatcher
- Post-clock simulation gives paper fills (same math as backtest fill simulator)
- Paper PnL tracked in parallel with live; divergence analysis exposes where sim-to-live lies

### Anti-cheat guarantees (master PRP §8.7)

- Lookahead: `asOf` enforcement at query layer, fuzz-tested in CI
- Survivorship: replay iterates every mint, no filter at event level
- Fill optimism: `realistic` is the default and the only mode permitted for pre-live promotion gating; `optimistic` is explicitly labeled and CI-gated off production
- Signal leakage: signal versions pinned in output; can't swap in a post-hoc improved signal silently

## Out of scope

- **Strategy DSL / agentic SDK** → PRP-08 (backtest API exists; strategy authoring comes later)
- **Shadow mode** — paper mode ships here; shadow (live decisions vs reference strategy, no submission) → PRP-08
- **Portfolio dashboards** → PRP-09
- **Second vertical** → PRP-06
- **Learned-model signal versions** — v1 signals are deterministic weighted rules; v2 (learned) is PRP-08+

## Deliverables

1. Event store operational — historical backfill of pump.fun from mainnet genesis completed; live tap running; queryable via DuckDB from example scripts.
2. 8 base signals + 7 derived signals implemented, each with version pin, unit tests, and query-latency benchmarks.
3. Backtest harness operational — `pnpm backtest <strategy>` runs the PRP-03 hardcoded strategy over the last 30 days of event history in < 60s with a complete PnL attribution output.
4. Paper mode running alongside live PRP-03 strategy — 14 days of parallel execution with divergence analysis.
5. Fill simulator calibrated from 30 days of live execution data from PRP-03.
6. Documentation — `ap3x-solana/docs/signals.md` with signal definitions, versioning policy, and query examples.

## Acceptance criteria (gate)

1. **Backtest-vs-live PnL match** — the PRP-03 hardcoded strategy's 14-day backtest on historical event store matches its 14-day live PnL within 15%. Validates the fill simulator is realistic.
2. **Same code in backtest / paper / live** — AST diff shows ≥95% strategy code shared across the three modes. Mode is a property of tool implementation; strategy code is unchanged.
3. **Determinism** — backtest regression test in CI: same inputs produce bit-identical outputs on consecutive runs.
4. **Lookahead fuzz** — 10,000 randomized signal queries verify no query returns post-`asOf` events. Zero leaks.
5. **Signal query performance** — p95 of `getToken + getHolders + getTrades` composite < 250ms on 30-day event store.
6. **Dev reputation v1 validated** — on a holdout set of 50 historical devs, v1 scoring's rug/graduated classification matches hand-labeled ground truth ≥80%.
7. **Wallet tagging recall** — known dev wallets tagged correctly ≥95%; known KOL wallets tagged correctly ≥80%; known sniper bots tagged correctly ≥90%.

## Key design decisions

- **Parquet + DuckDB, not Postgres.** Event log is append-only, columnar, time-partitioned — Parquet is the right tool. DuckDB gives SQL hot-path without the ops burden of ClickHouse. Scales to 1yr in 500GB locally queryable.
- **As-of everywhere.** Every signal query takes `asOf`. Even live queries set `asOf = now`. Uniform surface → backtest and live use identical code.
- **Signal versioning is load-bearing.** Strategies pin signal versions. A dev reputation model upgrade doesn't silently change backtest results for a strategy pinned to v1.
- **Deterministic v1 signals, learned v2 later.** v1 uses documented weighted sums so they can be audited + explained. Learned models (gradient boosting on wallet features) come after v1 is validated.
- **Paper mode shares the code path.** The same `submit_tx` function runs in backtest, paper, and live. Only the implementation behind a mode flag differs. Strategy code doesn't know which mode it's in.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Historical backfill completeness — are we missing early pump.fun history? | Cross-check event counts against Dune/external indexers; document any gaps; flag signals computed over incomplete windows |
| DuckDB query performance degrades at scale | Partition by date; precomputed signal caches at `(mint, asOf_bucket=1min)` granularity; escalate to ClickHouse if needed post-GA |
| Derived signal overfitting on backtest | Hold out the last 30 days from v1 training; out-of-sample validation required for every signal version promotion |
| Wallet tag false positives damage dev reputations | Conservative defaults; tags are advisory not blocking; audit log records every tag application |
| Storage costs at 500 GB/year local | Cold tier to S3/R2 after N days; local hot window is last 30-60 days; queries transparently span |

## What extracts to platform in PRP-05

These are the patterns from this PRP that become cross-vertical:

- **Event store framework** (Parquet + DuckDB + as-of semantics + versioning) → `@ap3x/signals-core`. The pump.fun-specific signal *implementations* stay here; the *framework* they use lifts out.
- **Virtual clock + fill simulator framework** → `@ap3x/backtest`. Pump.fun's curve-specific fill model stays; the framework (clock, replay, determinism, attribution) extracts.
- **Signal versioning + as-of contract** → `@ap3x/vertical` interface contract. Every vertical's signals must implement this.

Exactly what lifts and what stays is PRP-05's work — it looks at this PRP's output and makes the call concretely.

## Next

On gate pass: PRP-05 (platform extraction) unlocks. PRP-05 is a refactoring PRP; no new functionality.

# PRP: Pump.fun Agent Platform

**Status:** Draft v0.1 — adopted as master vertical spec for the AP3X platform roadmap
**Owner:** CJ (AP3X)
**Last updated:** 2026-04-19
**Target:** Agentic + declarative strategy platform for pump.fun on Solana, architected with the rigor of Claude Code (tight primitives, typed tools, hard safety gates)

---

## Role in the AP3X platform

This document is the **canonical pump.fun vertical spec** and doubles as the design target for the cross-vertical platform substrate. The content was originally authored as a pump.fun-standalone PRP; in the AP3X platform framing, it decomposes as follows:

- **Layers 1-3** (connectivity/keys, tx layer, protocol wrapper) and the pump.fun-specific portion of **Layer 4** (event sourcing, pump.fun-specific signals like dev reputation, graduation ETA, bundle detection) → **ship in `ap3x-solana/` as the pump.fun vertical.** These are Solana/pump.fun-specific and live with the vertical.

- **Layers 5-10** (safety & risk, tool schema, strategy runtime, portfolio, lifecycle, control plane) → **extract to `ap3x-platform/` as vertical-agnostic substrate after pump.fun forces them to exist concretely.** These get reused by every subsequent vertical (Hyperliquid, Polymarket, future non-crypto). The extraction is PRP-05 in the roadmap.

Success criteria in this document split along the same axis:

- **Pump.fun-specific criteria** (sub-800ms new-mint latency, bonding curve math correctness) stay with the pump.fun vertical spec.
- **Cross-cutting criteria** (backtest/paper/live code parity, kill switch SLA, policy enforcement structural guarantees) become platform-wide contracts that every vertical inherits.

Implementation of this master PRP is decomposed across phase-level PRPs:
- **01** Solana substrate (generic, not pump.fun-specific)
- **02** Pump.fun protocol + typed read-only client
- **03** Pump.fun execution + safety (write path, Jito, policy, circuit breakers)
- **04** Pump.fun signal layer + backtest harness
- **05** Platform extraction (vertical-agnostic substrate leaves the pump.fun vertical)
- **06** Hyperliquid Phase 0 (foundation)
- **07** Hyperliquid Phase 1 (signal layer)
- **08** Strategy runtime + SDK
- **09** Portfolio + lifecycle
- **10** Polymarket vertical
- **11** Future vertical template
- **12** Chad platform rebuild

See the [roadmap README](./README.md) for sequencing.

The rest of this document is the original pump.fun platform PRP as drafted on 2026-04-19.

---

## 1. Summary

Build a platform — not a single agent — on which many strategies (declarative rule-based, LLM-agentic, or hybrid) can be authored, backtested, paper-traded, and run live against pump.fun and PumpSwap on Solana.

The core insight: strategies are user code; the platform is the substrate. Like Claude Code, the platform ships a small set of well-typed primitives and composes them behind a safety layer. Alpha lives in strategy logic and signal interpretation, not in raw RPC access.

## 2. Goals and non-goals

### Goals

- Ship a substrate where writing a new pump.fun strategy takes hours, not weeks
- Make unsafe trading structurally impossible at the tool layer (not prompt-discouraged)
- Guarantee backtest → paper → live code parity (same code path, different submit endpoint)
- Sub-second reaction time on new mints with MEV-protected submission
- Make the signal layer the moat: derived intelligence (dev reputation, smart money, funding traces) that's hard to rebuild externally
- Support both deterministic DSL strategies and LLM-driven agentic strategies as first-class citizens

### Non-goals (v1)

- Chains other than Solana
- AMMs beyond pump.fun and PumpSwap
- A general-purpose trading terminal for humans (API/SDK first; UI is thin)
- Copy-trading as a product feature (tools support it; not a SKU)
- Custodial fund management or pooled capital products

## 3. Success criteria

**Technical:**
- New-mint-to-submitted-tx median latency < 800ms (p99 < 2s)
- Backtest of 1 trading day on 1 strategy completes in < 30s on a laptop
- Backtest / paper / live code paths share ≥ 95% of strategy code (measured by AST diff)
- Zero critical incidents in the first 90 days (incident = lost SOL outside declared risk budget, or platform bug causing non-consensual write)

**Product:**
- A new strategy author can go from empty file to paper-trading run in < 60 minutes using the SDK
- At least 3 meaningfully different strategies (snipe, momentum, graduation-arb) running in production within 90 days of platform GA
- Strategy authors can attribute PnL to specific signals within the platform (no external tooling required)

**Safety:**
- Every write tx is preceded by a simulation with a receipt; raw `sendTransaction` is not exposed
- Circuit breakers trip reliably in drift / drawdown / RPC-disagreement scenarios (verified quarterly by injection test)
- Kill switch reaches all live strategies within 5 seconds

## 4. Users and primary flows

**Strategy author (primary):** writes a strategy in the DSL or agentic SDK, iterates via backtest + paper, promotes to live with explicit approval.

**Operator:** monitors running strategies, approves Tier 2 trades when policy requires it, handles circuit-breaker events.

**Platform developer:** extends signals, tunes execution, maintains safety policy.

Primary flows:
1. Author → backtest → paper → shadow → live
2. Signal ingestion → derivation → strategy subscription → decision → simulation → approval → submission → confirmation → ledger → dashboard
3. Anomaly → circuit breaker trips → all strategies paused → operator investigates → manual resume

## 5. Architecture overview

Layers, bottom-up:

1. **Connectivity & keys** — RPC pool, Geyser streams, wallet + keypair mgmt
2. **Transaction layer** — v0 txs, ALTs, priority-fee estimator, Jito bundles, simulation
3. **Protocol wrapper** — typed pump.fun + PumpSwap client, curve math, event decoding
4. **Signal layer** — event-sourced storage, derived signals (reputation, smart money, clustering)
5. **Safety & risk** — policy engine, tiers, circuit breakers, kill switch, audit log
6. **Tool schema** — the LLM- and DSL-facing typed interface
7. **Strategy runtime** — declarative DSL runner + agentic SDK
8. **Portfolio layer** — capital allocator, cross-strategy risk, wallet routing
9. **Lifecycle tooling** — backtest harness, paper mode, shadow mode, dashboards, replay
10. **Control plane** — strategy registry, deployment, approvals, alerting

Non-negotiable architectural constraint: **the strategy-facing interface is identical in backtest, paper, and live.** Mode is a property of the tool implementation, not the strategy code.

## 6. Layer-by-layer specification

### 6.1 Connectivity & keys

**RPC pool**
- Primary + two fallbacks (Helius, Triton, QuickNode recommended); latency-scored, automatic failover
- Read path uses pool; write path pins to lowest-latency healthy node for tx submission
- All calls emit metrics (latency, error class, retry count)

**Geyser / streaming**
- Yellowstone gRPC subscription to pump.fun program ID for logs + account updates
- Parser that decodes program logs into typed events (`CreateEvent`, `TradeEvent`, `CompleteEvent`, migration events)
- Backpressure handling; stream restart on gap detection; gap replay via RPC historical
- Local stream checkpoint so a restart doesn't miss events

**Wallets**
- Encrypted keypair storage (libsodium secretbox, passphrase-derived key) or KMS/HSM
- Named wallets: `main`, `snipe_N`, `fund`, with explicit role and per-role caps
- Nonce / ATA management automatic; ATA creation is part of the tx builder, not the strategy
- SOL balance guard: reserve N SOL per wallet for rent + fees; strategies cannot spend into reserve

### 6.2 Transaction layer

**Builder**
- Versioned (v0) txs exclusively
- Maintains platform-owned ALT with pump.fun program accounts, common vaults, top tokens by volume
- Compute unit limit set from simulation + 15% buffer; never unbounded
- Fee payer = trading wallet by default; optional separate fee payer wallet for ops segregation

**Priority fee estimator**
- Rolling window (last N slots, default 20) of landed-tx fees per CU from Geyser
- Tiers map to percentiles: `low=p50`, `med=p75`, `high=p90`, `turbo=p99 + dynamic topup`
- Recomputed every slot; strategies select tier, never lamports
- Topup ceiling is a platform policy, not strategy-controllable

**Jito bundles**
- Bundle builder composes up to 5 txs atomically
- Tip computed as bounded % of expected profit (floor + cap), not strategy-picked lamports
- Revert protection: bundle includes a guard tx that aborts if curve state drifts > X bps between simulation and landing
- Default submission path for any write > 0.1 SOL; public RPC is fallback only

**Simulation**
- Every write is preceded by `simulateTransaction` with replaced recent blockhash
- Expected-state assertions: expected tokens out, expected curve state post-tx, expected balance changes
- Returns a `receipt_id` valid for 10 seconds (configurable); `submit_tx` must reference a live receipt

### 6.3 Pump.fun protocol wrapper

**Typed client**
- One struct per instruction: `BuyParams`, `SellParams`, `CreateParams`, `MigrateParams`
- No raw instruction data exposed to strategies
- Supports both bonding-curve (pre-graduation) and PumpSwap AMM (post-graduation) with unified `buy`/`sell` interface; routing is internal

**Curve math**
- Pure functions: `price_from_reserves`, `tokens_out_for_sol_in`, `sol_out_for_tokens_in`, `pct_to_graduation`, `price_impact_bps`
- Fully unit-tested against on-chain observed trades (regression suite)

**Event decoding**
- Geyser logs → typed events with slot, timestamp, signature, payload
- One decoder per event variant; exhaustive match enforced at type level
- Metaplex metadata resolution for token name/symbol/URI with local cache

### 6.4 Signal layer

**Event store**
- Storage: Parquet on object storage (S3/R2) partitioned by day, hot index in ClickHouse or DuckDB
- One row per on-chain event, immutable, append-only
- Schema versioned; migrations via view layer
- Target: one year of pump.fun in < 500 GB compressed

**Query semantics**
- All signal queries take an `as_of` timestamp (the virtual clock)
- Queries return only events with `observed_at <= as_of`
- This is enforced at the query layer, not by convention — strategies **cannot** peek ahead

**Base signals (cheap, direct)**
- `get_token(mint, as_of)` — metadata, curve state, price, graduation %, liquidity, authorities
- `get_holders(mint, as_of, limit)` — top N, concentration (HHI), % held by wallets < 24h old
- `get_trades(mint, as_of, window)` — recent trades with wallet tags
- `get_candles(mint, as_of, interval, count)` — OHLCV derived from trades
- `new_mint_stream(since, filter)` — subscription or bounded query

**Derived signals (the moat)**
- `dev_reputation(wallet, as_of)` — features: prior mint count, rug rate, graduation rate, median peak mcap, median time-to-peak, funding-source cluster id, first-seen age. Score = learned model over these; version pinned.
- `wallet_tag(wallet, as_of)` — multi-label: `dev`, `sniper`, `kol`, `insider`, `fresh`, `whale`, `rugger_history`, `graduated_dev`. Tags are derived from historical behavior, retrained periodically, version pinned.
- `smart_money_flow(mint, as_of, window)` — net SOL flow from wallets with historical profitability above threshold
- `bundle_detection(mint, slot)` — detects same-block coordinated buys (likely sniper bundles) by wallet-cluster analysis
- `correlation(mint, as_of, window)` — other mints moving in lockstep (coordinated pumps)
- `social_signal(mint, as_of)` — optional off-chain: Twitter/TG mention velocity, KOL mentions. Separate ingestion pipeline; strategies opt in.

**Versioning**
- Every derived signal has a `signal_version`. Backtests pin versions. Upgrades run in shadow against prior version before rollout. Strategies can declare minimum signal version.

### 6.5 Safety & risk

**Tool-layer enforcement**
- All risk caps enforced inside `submit_tx` and `simulate_*`, not in the strategy prompt or DSL
- Strategy cannot bypass by construction — no raw instruction builder is exposed

**Approval tiers (see §7.2)**
- Tier 0: reads, sims — auto
- Tier 1: small writes within policy — auto, logged
- Tier 2: larger writes / yellow flags — soft approval with timeout-default-approve
- Tier 3: novel/irreversible — hard approval, timeout-default-reject

**Per-dimension caps (defaults; tunable per strategy, bounded by platform max)**
- Per-trade SOL
- Per-hour SOL (rolling)
- Per-day SOL (rolling)
- Per-wallet aggregate open exposure
- Max concurrent open positions
- Max slippage bps
- Max priority fee tier
- Per-strategy total capital allocation

**Circuit breakers**
- Rolling 1h drawdown > X% → pause all Tier 1/2 auto-execution
- Rolling 24h drawdown > Y% → pause all auto-execution
- N consecutive losing trades → pause
- RPC disagreement (two sources, differing curve state > threshold) → pause writes
- Sim-to-confirm latency > threshold → pause (degraded conditions, likely MEV-hostile)
- Wallet balance drift vs. internal ledger > tolerance → pause + alert

**Kill switch**
- `pause(reason)` callable by agent, operator, or breaker
- Propagates to all strategies within 5s
- `resume()` requires human operator; never self-resume

**Audit log**
- Append-only; one record per Tier 1+ action
- Schema (§7.3)
- Immutable storage; retention ≥ 1 year

### 6.6 Tool schema (strategy-facing API)

The complete, stable, typed interface. See §7.1 for rationale; schema in §7.4.

Read tools (Tier 0): `get_token`, `get_holders`, `get_dev`, `get_new_mints`, `get_trades`, `get_candles`, `get_wallet`, `watch`, `stream_poll`

Simulation tools (Tier 0, required before writes): `simulate_buy`, `simulate_sell`, `simulate_create`

Write tools (Tier 1-3, receipt-gated): `submit_tx`, `cancel_pending`

Position tools: `set_exit_rule`, `list_exit_rules`, `remove_exit_rule`, `get_position`, `list_positions`

Control & memory: `get_risk_budget`, `pause`, `request_human`, `log_decision`

Deliberately **not** exposed: raw `sendTransaction`, arbitrary program invocation, keypair export, unbounded priority fee, skip-preflight flag, raw instruction assembly.

### 6.7 Strategy runtime

**Mode A: Declarative DSL**
- YAML/JSON with typed schema
- Entry conditions, sizing, exits, risk limits
- Compiled to a rule-engine execution plan
- Fast (microseconds per decision), fully backtestable, deterministic

**Mode B: Agentic SDK**
- Python/TypeScript SDK wrapping the tool schema
- LLM loop with approval tiers mediating tool calls
- Strategy declares: event triggers, model, system prompt, tool budget per decision, time budget per decision

**Hybrid**
- Declarative hot path (sub-second reactions on new mints)
- Agentic evaluation path (periodic position review, narrative assessment)
- Handoff via position manager

**Runtime primitives**
- `on_event(filter, handler)` — event-driven
- `schedule(interval, handler)` — periodic
- `position.manage(mint, rules)` — hand off to rule engine
- Strategies are sandboxed; resource-bounded (CPU, memory, tool calls per window)

### 6.8 Portfolio layer

- **Capital allocator**: each strategy has an allocation; unused SOL pools; rebalancing rule (EW, risk-parity, perf-weighted) configurable
- **Order deduplication**: concurrent buys on same mint merged, size split by conviction
- **Cross-strategy risk**: aggregate exposure, aggregate drawdown, one kill switch
- **Wallet routing**: strategy → wallet map with per-wallet caps; useful for counterparty, tax lots, op-sec

### 6.9 Lifecycle tooling

**Backtest harness (§8)**
- Event-sourced replay with virtual clock
- Realistic fill modeling
- Deterministic, reproducible, versioned
- Performance target: 1 day / 30s, 1 month / 15min

**Paper mode**
- Live signal streams, simulated fills
- Same code path as live; only `submit_tx` routing differs
- Required gate before live (min 1-2 weeks per new strategy)

**Shadow mode**
- Live data, live decisions, no submission
- Compares to a reference strategy
- Required gate before live capital > threshold

**Dashboards**
- PnL by strategy, signal, dev bucket, hour, wallet
- Live position state, open risk, budget utilization
- Signal health (staleness, gap rate, disagreement)

**Alerting**
- Strategy silent > N seconds
- Circuit breaker trips
- Wallet drift
- RPC degradation
- Unusual fill latency or realized slippage

**Replay**
- Given a trade ID, reconstruct complete signal state at decision time
- Re-run strategy decision against that state for debugging
- Critical for LLM strategy debugging

### 6.10 Control plane

- Strategy registry with versioning
- Deployment: promote between envs (dev → paper → shadow → live)
- Approval queue for Tier 2/3 with channel integrations (Telegram, Discord, web UI)
- Policy as code, versioned, diff-reviewed before merge
- Secrets / key management separate from strategy code

## 7. Key design decisions

### 7.1 Why a typed tool schema (not raw RPC)

Raw RPC + prompt discipline is how agents lose money. The LLM will compose unsafe calls, mis-serialize instruction data, submit without simulation, skip preflight, over-pay priority fees. Every such failure mode is an incident report.

A typed schema makes unsafe actions structurally impossible: no raw lamports, no raw instructions, no skip-safety flags, simulation required before write. The schema is small enough to fit on two screens — if it grows, primitives aren't composing well.

### 7.2 Approval tiers (expanded)

| Tier | Examples | Approval | Default |
|------|----------|----------|---------|
| 0 | All reads, all sims | None | Allow |
| 1 | Buy ≤ 0.5 SOL on risk-clean mint, slippage ≤ 500bps | None; logged | Allow |
| 2 | Buy 0.5-2 SOL, slippage > 500bps, yellow flags | Notify, N-sec window | Allow on timeout |
| 3 | Buy > 2 SOL, create token, blacklisted dev, cap override | Notify, sync approval | Reject on timeout |

Thresholds are platform-wide defaults; strategies can tighten but not loosen. Enforcement is at `submit_tx`, not at prompt.

### 7.3 Audit log schema

```json
{
  "ts": "ISO-8601",
  "run_id": "string",
  "strategy_id": "string",
  "strategy_version": "string",
  "tool": "string",
  "receipt": { "...full simulation output..." },
  "thesis": "string (>=20 chars)",
  "policy_tier": "0|1|2|3",
  "policy_version": "string",
  "signal_versions": { "dev_reputation": "v3.2", "...": "..." },
  "budget_before": { "sol_today_remaining": 2.4, "open_positions": 3 },
  "budget_after":  { "sol_today_remaining": 1.9, "open_positions": 4 },
  "outcome": {
    "signature": "string|null",
    "status": "confirmed|failed|rejected|timeout",
    "confirmed_ms": 820,
    "realized_slippage_bps": 180,
    "realized_price_sol": "...",
    "error_class": "string|null"
  },
  "model": "string|null",
  "parent_decision_id": "string|null"
}
```

### 7.4 Example tool schema: `simulate_buy`

```json
{
  "name": "simulate_buy",
  "description": "Price a buy against the current bonding curve. Returns a receipt_id valid for 10 seconds. Does not submit. Fails closed if risk caps would be breached.",
  "input_schema": {
    "type": "object",
    "required": ["mint", "sol_amount", "max_slippage_bps", "wallet_id", "thesis"],
    "properties": {
      "mint": {
        "type": "string",
        "pattern": "^[1-9A-HJ-NP-Za-km-z]{32,44}$"
      },
      "sol_amount": { "type": "number", "minimum": 0.001, "maximum": 5.0 },
      "max_slippage_bps": { "type": "integer", "minimum": 50, "maximum": 3000 },
      "wallet_id": { "type": "string", "enum": ["main", "snipe_1", "snipe_2"] },
      "priority_fee_tier": {
        "type": "string",
        "enum": ["low", "med", "high", "turbo"],
        "default": "med"
      },
      "thesis": {
        "type": "string",
        "minLength": 20,
        "description": "Why this trade. Logged, reviewed, attributable."
      }
    }
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "receipt_id": { "type": "string" },
      "tokens_out": { "type": "number" },
      "price_impact_bps": { "type": "integer" },
      "priority_fee_lamports": { "type": "integer" },
      "total_cost_sol": { "type": "number" },
      "expires_at": { "type": "string", "format": "date-time" },
      "warnings": { "type": "array", "items": { "type": "string" } }
    }
  },
  "error_classes": [
    "SLIPPAGE_EXCEEDED", "RISK_CAP_HIT", "TOKEN_BLACKLISTED",
    "WALLET_INSUFFICIENT", "CURVE_STATE_STALE", "RPC_RETRIABLE"
  ]
}
```

### 7.5 Declarative strategy example

```yaml
strategy_id: early_dev_snipe_v1
version: "0.3.0"
min_signal_versions:
  dev_reputation: "v3.1"
wallet: snipe_1
capital_sol: 5.0

entry:
  event: new_mint
  all:
    - dev_reputation.graduation_rate: { gte: 0.3 }
    - dev_reputation.rug_rate: { lte: 0.1 }
    - initial_dev_buy_sol: { between: [0.5, 2.0] }
    - bundle_buyers_count: { between: [0, 3] }
    - holders.pct_fresh_wallets: { lte: 0.4 }
  size_sol: 0.3
  max_slippage_bps: 800
  priority_fee_tier: turbo
  use_jito: true

exits:
  - take_profit: { mult: 2.5, size_pct: 50 }
  - take_profit: { mult: 5.0, size_pct: 30 }
  - trailing_stop: { activate_mult: 2.0, trail_pct: 25 }
  - hard_stop: { loss_pct: 40 }
  - time_stop: { minutes: 30, condition: "mcap_delta_pct < 20" }

risk:
  per_hour_sol: 1.5
  per_day_sol: 4.0
  max_concurrent_positions: 6
```

### 7.6 Agentic strategy example (pseudocode)

```python
from pumpfun_sdk import Strategy, tools

class NarrativeMomentum(Strategy):
    id = "narrative_momentum_v1"
    wallet = "main"
    capital_sol = 10.0
    model = "claude-opus-4-7"
    decision_budget = { "tool_calls": 30, "max_seconds": 8 }

    triggers = [
        on_event("new_mint", filter={ "dev_reputation.score": { "gte": 0.6 } }),
        schedule(seconds=60, handler="review_positions"),
    ]

    system_prompt = """
    You trade pump.fun tokens with a momentum + narrative thesis.
    Use the provided tools. Always simulate before submitting.
    Articulate a thesis in each submit_tx call. Hit pause() on anomalies.
    """

    def on_new_mint(self, event):
        return self.agent_decision(context=event)

    def review_positions(self):
        return self.agent_decision(context=tools.list_positions())
```

## 8. Backtest harness detailed specification

### 8.1 Time model

- Single virtual clock, monotonic, advanced by event
- All signal queries take an implicit `as_of = clock_now`
- Strategy callbacks fire with event timestamp as clock
- No wall-time access available to strategies during backtest

### 8.2 Storage

- Raw events: Parquet on object store, partitioned by `date`
- Columns: `slot`, `block_time`, `signature`, `program_id`, `event_type`, `payload` (typed), `ingest_time`
- Hot path: DuckDB view over Parquet for signal queries
- Derived signal snapshots: cached per `(signal, key, as_of_bucket)` to avoid recomputation; invalidated on signal version bump

### 8.3 Fill modeling

Given a simulated submission at clock T with size S, slippage B, priority fee tier P:

1. Sample latency L from observed distribution (live-calibrated): actual submission = T + L
2. Look up curve state at T + L from event history
3. Compute expected fill against that curve
4. Check real on-chain activity in slot window around T + L:
   - Competing buys → reduce landing probability proportional to tier P
   - Curve moved beyond B → `failed_slippage`
   - Revert events → `failed_revert`
5. Outcomes: `filled` (realistic price), `failed_slippage`, `failed_revert`, `landed_late` (filled at worse price)

Calibration source: ≥ 30 days of real platform execution data. Bootstrap defaults until calibrated: 50% worse slippage than naive, 20% failure rate on contested new mints, latency mean 400ms / p99 1.5s.

### 8.4 Determinism

Backtest inputs:
- `strategy_version`
- `policy_version`
- `signal_versions` (map)
- `date_range`
- `initial_capital_sol`
- `fill_model` (`realistic` | `optimistic` | `pessimistic`)
- `seed` (controls latency sampling, fill stochasticity)

Same inputs → bit-identical outputs. Verified by regression test in CI.

### 8.5 Output

```python
result.pnl_timeseries        # DataFrame: ts, equity_sol, drawdown
result.trades                # full ledger with sim, fill, exit, PnL
result.attribution.by_signal # PnL contribution per signal
result.attribution.by_dev_bucket
result.attribution.by_hour
result.compare_to(other)     # side-by-side
result.replay(trade_id)      # full signal state at decision time
result.metrics               # sharpe, max_dd, win_rate, avg_R, trade_count
```

### 8.6 Performance

Targets (laptop-class, M-series or equivalent):
- 1 day, 1 strategy, declarative: < 30s
- 1 month, 1 strategy, declarative: < 15 min
- 1 day, 1 strategy, agentic (Claude Opus 4.7): < 10 min with response cache, < 60 min cold

Techniques:
- Columnar scans, predicate pushdown
- Precomputed signal caches at `(mint, as_of_bucket=1min)` granularity
- Event-filtered iteration (don't replay trades on mints a strategy never touches)
- Parallelism across date partitions for sweeps

### 8.7 Anti-cheat guarantees

- **Lookahead**: enforced by `as_of` in query layer; fuzz test verifies no query returns post-`as_of` rows
- **Survivorship**: replay iterates every mint; no filter at event level
- **Fill optimism**: `realistic` mode is the default and the only one permitted for pre-live promotion gating; `optimistic` explicitly labeled
- **Signal leakage**: signal versions pinned in output; can't swap in a post-hoc improved signal silently

## 9. Build sequence and milestones

### Phase 0: Foundations (weeks 1-3)
- RPC pool + Geyser stream + event decoder
- Wallet mgmt + encrypted key store
- Versioned tx builder + ALT + priority fee estimator
- Pump.fun typed client (read-only first)

**Gate:** can observe every on-chain pump.fun event with < 500ms lag and compute accurate curve state locally.

### Phase 1: Execution + safety (weeks 3-6)
- Write path: simulate_buy/sell/create + submit_tx with receipts
- Jito bundle integration
- Policy engine + tiers + audit log
- Circuit breakers + kill switch
- One hardcoded strategy running end-to-end on small capital

**Gate:** 7 consecutive days live with no out-of-budget writes, complete audit trail, clean breaker behavior on injected anomalies.

### Phase 2: Backtest + paper (weeks 6-10)
- Event store (historical backfill + live tap)
- Backtest harness with virtual clock
- Fill simulator (realistic mode, bootstrap calibration)
- Paper mode sharing live code path
- Deterministic regression suite

**Gate:** backtest of hardcoded strategy matches live PnL within 15% over 14-day window; same code runs in backtest, paper, live.

### Phase 3: Strategy runtime + SDK (weeks 10-14)
- Declarative DSL compiler + runner
- Agentic Python SDK with tool schema bindings
- Strategy registry, versioning, promotion flow
- Shadow mode

**Gate:** external author ships a new declarative strategy to paper in < 60 minutes from onboarding.

### Phase 4: Portfolio + lifecycle (weeks 14-18)
- Capital allocator, order dedup, cross-strategy risk
- Wallet routing
- Dashboards, alerting, replay tooling
- Fill model calibration from accumulated live data

**Gate:** three meaningfully different strategies running concurrently with clean allocation and zero cross-contamination.

### Phase 5: Signal expansion + hardening (weeks 18+)
- Dev reputation v2 (learned model)
- Smart money tags
- Bundle/cluster detection v2
- Optional social signals pipeline
- Load testing, chaos testing, incident drills

**Gate:** platform GA.

## 10. Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Backtest overfits to history, loses live | Strategy losses | Realistic fill model; paper gate; shadow gate; out-of-sample holdout |
| MEV / sandwiching drains alpha | Degraded PnL | Jito-default for writes > 0.1 SOL; revert protection; post-hoc MEV detection → validator avoidance |
| RPC/Geyser outage during active positions | Unmanaged risk | Multi-provider pool; health-scored routing; circuit breaker on disagreement; strategies expose exit-on-degradation rule |
| LLM strategy composes unsafe sequences | Loss event | Typed schema; receipt-gated writes; tier enforcement at tool layer |
| Pump.fun protocol upgrade breaks client | Downtime, bad state | Versioned client; event schema compat tests in CI; canary before full deploy |
| Priority fee inflation prices out strategies | Reduced fills | Dynamic tiers from live percentiles; strategy-declared max tier; alerting on fill-rate drop |
| Key compromise | Total loss | HSM/KMS for live keys; per-wallet caps; anomaly detection on outflows; hot/cold separation |
| Signal drift (dev reputation model ages) | Silently degrading PnL | Signal versioning; shadow-eval new versions; attribution dashboards flag drift |
| Regulatory exposure | Legal risk | Platform-as-infrastructure stance; no custodial fund mgmt in v1; consult counsel pre-GA |

## 11. Open questions

1. **Hosting model**: fully self-hosted SDK only, or managed runtime where users deploy strategies to our infra? Affects key custody story significantly.
2. **Keys**: HSM per live strategy, or shared HSM with per-strategy budget enforcement in software?
3. **Jito relay selection**: single relay, relay pool, or strategy-selectable?
4. **Pricing / monetization**: flat fee, SOL % of volume, revenue share on profitable strategies, or free SDK + paid signals?
5. **Signal sharing across strategies**: cache shared or per-strategy isolated? Affects cost and correlation risk.
6. **LLM provider**: Claude only, or multi-provider? Affects determinism story for agentic backtests.
7. **Public vs. private**: open-source the SDK and execution layer, closed-source the signal layer? Or fully closed?
8. **Compliance**: treatment of wallet tagging — is `kol`/`insider` labeling a liability surface?

## 12. Appendix

### A. Glossary

- **Bonding curve**: pre-graduation pump.fun pricing mechanism based on virtual reserves
- **Graduation**: migration from bonding curve to PumpSwap AMM at liquidity threshold
- **Bundle**: Jito atomic tx group landed together
- **ALT**: Address Lookup Table, Solana v0 tx feature enabling compact account references
- **Geyser**: Solana validator plugin providing streaming account/tx updates
- **Receipt**: short-lived simulation output required to submit a write
- **Tier**: approval level (0-3) determining autonomy for a given action
- **Signal**: derived on-chain or off-chain intelligence consumed by strategies
- **Thesis**: required string rationale attached to every write, logged for attribution

### B. Referenced standards

- Solana v0 transactions, ALTs
- Jito bundle submission protocol
- Metaplex Token Metadata standard
- Yellowstone gRPC Geyser interface

### C. Initial policy defaults (tunable, versioned)

```yaml
platform_defaults:
  per_trade_sol_max: 5.0
  per_hour_sol_max: 10.0
  per_day_sol_max: 50.0
  max_concurrent_positions: 20
  max_slippage_bps: 3000
  min_slippage_bps: 50
  receipt_ttl_seconds: 10
  jito_threshold_sol: 0.1
  circuit_breakers:
    rolling_1h_drawdown_pct: 15
    rolling_24h_drawdown_pct: 25
    consecutive_loss_count: 6
    sim_to_confirm_p99_ms: 3000
    rpc_curve_disagreement_bps: 200
  kill_switch_propagation_sla_ms: 5000
```

---

**End of PRP.**

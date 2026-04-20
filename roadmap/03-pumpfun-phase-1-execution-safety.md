# PRP-03 — Pump.fun vertical, Phase 1: Execution + Safety

**Repo:** `ap3x-solana/` (continues from PRP-01 + PRP-02 + PRP-02.5)
**Depends on:** PRP-01 (Solana substrate), PRP-02 (Solana runtime), PRP-02.5 (pump.fun protocol)
**Unblocks:** PRP-04 (signal layer), PRP-05 (platform extraction)
**Estimate:** 3 weeks solo
**Master spec:** [00-master-platform-prp.md §6.2-§6.5, §7](./00-master-platform-prp.md)

## Goal

Ship the **write path** for pump.fun with **receipt-gated simulation**, **Jito bundle execution**, and the first version of the **policy engine** (tool schemas, tiers, circuit breakers, audit log, kill switch). By the end of Phase 1 a hardcoded strategy runs end-to-end on small live capital with structurally enforced risk caps. Unsafe trading is impossible at the tool layer — the guarantee the platform sells on.

## In scope

### Relies on `@ap3x/pumpfun-protocol` from PRP-02.5

- Instruction builders (`buildCreate`, `buildBuy`, `buildSell`, `buildPumpSwapSwap`), typed params (`CreateParams`, `BuyParams`, `SellParams`, `PumpSwapSwapParams`), and unified `buy(mint, params)` / `sell(mint, params)` routing across the graduation boundary all ship in PRP-02.5. PRP-03 consumes them unchanged; nothing to extend here.

### Package `@ap3x/solana-tx` (extended from PRP-01)

- **Simulation** — `simulateTransaction` with replaced recent blockhash; expected-state assertions bound to each simulation: expected tokens out, expected post-tx curve state, expected balance changes. Returns a **receipt** — opaque short-lived token, default TTL 10 seconds.
- **Receipts** — bound to a simulation output + expected-state bundle. `submit_tx` requires a live receipt; expired receipts are rejected. Receipts record the exact blockhash + slot + expected outcome; post-submission we assert the receipt held.
- **Jito bundle builder + dispatcher** — compose up to 5 txs atomically. Tip computed as bounded percent of expected profit (platform policy sets floor + cap, not strategies). Revert protection: bundle includes a guard tx aborting if curve state drifts > X bps between simulation and landing. Default submission path for writes > 0.1 SOL; public RPC is fallback.
- **Submit path** — `submit(receipt, options)`. Takes a receipt; pins to the lowest-latency healthy RPC node (write path affinity from PRP-01); returns a confirmation monitor that emits `confirming → confirmed | failed` via callback or promise.

### Package `@ap3x/pumpfun-policy` (new)

- **Tool schema definitions** — typed input/output schemas for every action (simulate_buy, simulate_sell, simulate_create, submit_tx, cancel_pending, set_exit_rule, list_positions, get_risk_budget, pause, request_human, log_decision). JSON Schema output for LLM tool calling; TS types for DSL. This is pump.fun-specific in Phase 1 but will be the template for `@ap3x/policy` in PRP-05.
- **Approval tiers** (per master PRP §7.2):
  - Tier 0: reads, sims — always allow
  - Tier 1: small writes within policy — auto, logged
  - Tier 2: larger writes / yellow flags — soft approval with timeout-default-approve
  - Tier 3: novel or irreversible (token creation, cap override, blacklisted dev) — hard approval with timeout-default-reject
- **Per-dimension risk caps** enforced at tool layer (strategy cannot bypass):
  - per_trade_sol, per_hour_sol, per_day_sol (rolling windows)
  - per_wallet_aggregate_open_exposure
  - max_concurrent_open_positions
  - max_slippage_bps, max_priority_fee_tier
  - per_strategy_total_capital_allocation
- **Circuit breakers** (master PRP §6.5):
  - rolling 1h drawdown > X% → pause tier 1/2 auto
  - rolling 24h drawdown > Y% → pause all auto
  - N consecutive losing trades → pause
  - RPC disagreement on curve state > threshold → pause writes
  - sim-to-confirm latency > threshold → pause (MEV-hostile signal)
  - wallet balance drift vs internal ledger > tolerance → pause + alert
- **Kill switch** — `pause(reason)` callable by agent, operator, or breaker. Propagates to all live strategies within 5 seconds. `resume()` requires human operator; never self-resume.
- **Audit log** (schema per master PRP §7.3) — append-only, one record per Tier 1+ action. Persisted to a local SQLite table initially; pluggable backend (Postgres, S3 Parquet) from day one via interface.
- **Thesis requirement** — every write tool requires a `thesis: string` argument with minLength 20. Logged + attributable + no way to submit without one.

### Hardcoded reference strategy

- **`ap3x-solana/examples/hardcoded-snipe/`** — a single-file strategy that:
  - Subscribes to new pump.fun mints via Phase 0 Geyser client
  - Applies a simple filter (dev buy 0.5-2 SOL, holders <3 snipers, not blacklisted dev)
  - Simulates a buy with reasonable slippage via `simulate_buy`
  - Submits via Jito bundle if sim passes
  - Sets exit rules: 2x TP 50% size, 5x TP 30% size, 25% trailing from 2x, -40% hard stop, 30-min time stop
  - Logs decisions through the audit log
- Runs on a live wallet with capital cap 1 SOL. Exists to validate the stack end-to-end. Deleted (or moved to examples archive) once PRP-08's real strategy SDK ships.

## Out of scope

- **Strategy DSL** → PRP-08 (hardcoded strategy only in Phase 1 — it's a validator, not a product)
- **Agentic SDK** → PRP-08
- **Event store, signal derivations** → PRP-04
- **Backtest + paper mode** → PRP-04 + PRP-05
- **Portfolio allocator, multi-strategy** → PRP-09
- **Dashboards** → PRP-09
- **Hyperliquid / other verticals** → PRP-06+

## Deliverables

1. Packages above built, tested, working inside `ap3x-solana/` monorepo.
2. Hardcoded reference strategy runs **7 consecutive days live** on capped 1 SOL wallet with zero out-of-budget writes, complete audit trail, clean breaker behavior on injected anomalies.
3. Injection test suite — deliberate out-of-budget attempts, receipt expiry races, RPC disagreement scenarios, stream lag scenarios — all correctly rejected / breakered.
4. Policy + tiers + caps documented in `ap3x-solana/docs/policy.md` with the complete schema (format inheritable by future verticals).
5. Audit log schema + sample records in `ap3x-solana/docs/audit-log.md`.
6. Kill switch tested: operator hits pause → all live activity halts within 5s (measured via log timestamps); resume requires out-of-band confirmation.

## Acceptance criteria (gate)

1. **7 consecutive days live** with the hardcoded strategy on 1 SOL cap, zero incidents (incident = lost SOL outside declared risk budget, or any non-consensual write).
2. **Receipt-gated writes enforced by construction** — verified by fuzz test: every path into `submit_tx` requires a live receipt; no code path bypasses.
3. **Tier thresholds enforced at tool layer** — verified by injection: strategy attempts buys at 0.6 SOL with no approval → rejected; buys at 3 SOL → hard-approval path triggers; attempts to override tier inline → tool schema rejects.
4. **Circuit breakers trip on all 6 scenarios** (rolling 1h DD, rolling 24h DD, consecutive losses, RPC disagreement, sim-to-confirm latency, balance drift) — verified by scripted injection, all trip within specified thresholds.
5. **Kill switch propagation < 5s** — measured via log timestamps across multiple strategy instances.
6. **Audit log completeness** — every Tier 1+ action has a record with all required fields populated, including `thesis`. Log is append-only verified by tamper-test.
7. **Jito bundle path default-used for writes > 0.1 SOL** — verified by submission logs during live run.
8. **Revert protection triggered at least once** during live run (or simulated via fork slot replay) — verified bundle aborts when curve state drifts beyond threshold between sim and land.

## Key design decisions

- **Receipt as the only way to write.** Structural, not procedural. The write APIs literally take a `Receipt` type; nothing else type-checks. No `sendRawTransaction` escape hatch exposed.
- **Policy as enforcement, not configuration.** Tier rules and caps are tool-layer code, not prompt instructions. An LLM strategy cannot talk the policy out of rejecting an over-budget call.
- **Thesis required for every write.** The LLM must articulate a reason; attribution depends on it; acquisition due diligence reads audit logs and the thesis field is how intent is proven.
- **Pump.fun-specific policy in Phase 1, extracted in PRP-05.** The policy engine encoded here will become `@ap3x/policy` after Hyperliquid forces cross-vertical generalization. Don't over-generalize now.
- **Jito-by-default for writes > 0.1 SOL.** MEV-protection is table-stakes for meme-coin sniping; public RPC is fallback only.
- **Hardcoded strategy is a validator, not a product.** It ships in `examples/`, not as a real strategy. Its job is to prove the rest of the stack works end-to-end.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Jito tip competition prices us out during peak congestion | Dynamic tip ceiling from live landed-bundle tip percentiles; circuit-break auto-exec if fill rate drops below threshold |
| Receipt TTL too tight causes legitimate submissions to expire | Start at 10s default, tune based on live submission latencies; per-call override with max 30s cap |
| Circuit breaker false positives pause strategies unnecessarily | Start permissive, tune thresholds per live data; each breaker has a quarantine-and-review mode before outright pause |
| Audit log write fails mid-submission | Log write goes to durable backend BEFORE the tx submit; failed log = failed submit (fail closed) |
| First live capital mistake | Hardcoded strategy capital cap is 1 SOL, breaker thresholds are conservative for first week; manual operator review at each day boundary |

## Phase 1 → Phase 2 unlock

Once live for 7 clean days, the stack is proven. PRP-04 (signal layer + backtest harness) starts next — but fundamentally the vertical is **executing real trades** from Phase 1 onward. PRP-04 makes strategies much smarter; PRP-03 makes them possible.

## Next

On gate pass: PRP-04 (signal layer) unlocks.

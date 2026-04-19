# PRP-09 — Portfolio + lifecycle tooling

**Repo:** `ap3x-platform/` + `ap3x-ops/` (new, for dashboards)
**Depends on:** PRP-08 (strategy runtime live)
**Unblocks:** platform GA; PRP-12 (Chad rebuild)
**Estimate:** 3-4 weeks solo
**Master spec:** [00-master-platform-prp.md §6.8-§6.10](./00-master-platform-prp.md)

## Goal

Operational completeness — run **three or more strategies concurrently** across pump.fun + Hyperliquid with clean capital allocation, no cross-contamination, full observability. This is the "platform is actually a platform" milestone; up through PRP-08 we could run one strategy at a time cleanly. From here on, many strategies coexist under a shared capital + risk + alerting umbrella.

## In scope

### Package `@ap3x/portfolio` (new, in `ap3x-platform/`)

**Capital allocator:**
- Each strategy has an allocation (fixed SOL/USD amount or % of pool)
- Unused SOL/USD pools per wallet
- Rebalancing rule configurable: equal-weight (EW), risk-parity, performance-weighted (30-day rolling Sharpe)
- Allocations bounded by platform-wide limits (no single strategy > 25% of total capital without hard approval)

**Order deduplication:**
- Concurrent buys on same mint/coin from different strategies merged
- Size split by conviction (strategy declares conviction 0-1; sizes pro-rata)
- Reduces duplicate fill risk + MEV exposure

**Cross-strategy risk:**
- Aggregate exposure per coin/mint across all strategies
- Aggregate exposure per wallet across all strategies
- Aggregate drawdown (platform-wide, not per-strategy)
- One shared kill switch reaches all strategies

**Wallet routing:**
- Strategy → wallet map with per-wallet caps
- Useful for: counterparty separation, tax lot management, op-sec, strategy-level risk isolation
- Wallet creation + funding workflow (encrypted keypair store from `@ap3x/vault`)

### Monorepo `ap3x-ops/` (new) — dashboards + alerting

**Dashboard app:**
- Next.js (same stack as Chad's UI)
- Live view: PnL by strategy + signal + dev bucket + hour + wallet
- Position state across verticals: open risk, budget utilization
- Signal health: staleness, gap rate, cross-source disagreement
- Audit log browser with filters + search
- Backtest result viewer with side-by-side comparison
- Replay viewer: given a trade ID, render the full signal state at decision time

**Alerting:**
- Strategy silent > N seconds
- Circuit breaker trips
- Wallet drift
- RPC degradation
- Unusual fill latency or realized slippage
- Funding rate spike on open Hyperliquid positions
- Pump.fun upstream API issues (leverages Chad's diag infrastructure pattern)

Alert channels: Telegram (primary), Discord, Slack, email. Channel preferences per alert class.

### Fill model calibration from accumulated data

- By this point the platform has 30+ days of live execution across both verticals
- Recalibrate pump.fun + Hyperliquid fill simulators from real data
- Auto-recalibration quarterly or on significant drift

### Control plane essentials

- Strategy deployment workflow: promote between envs (dev → paper → shadow → live)
- Approval queue for Tier 2/3 with Telegram/Discord integration
- Policy-as-code: all policy configs in version control, diff-reviewed before merge
- Secrets/key management separate from strategy code (strategies reference wallets by name, never see private keys)

### Replay + debugging tooling

- Given a trade ID, CLI + dashboard can reconstruct complete signal state at decision time
- Re-run strategy decision against that state for LLM strategy debugging
- Compare expected vs actual outcomes with attribution

### Fill simulator → production gap analysis

- Weekly job: for every live trade in the last week, rerun backtest fill sim at same clock point
- Divergence metrics: expected vs realized slippage distribution
- Feedback into fill model parameters

## Out of scope

- **Public-facing dashboards** (SaaS UI for external strategy authors) — post-GA product work
- **Billing / monetization** (usage metering, payment) — post-GA, open question §11.4 of master PRP
- **Multi-tenancy / isolation** — single-operator platform for now; multi-tenant is a post-GA architecture discussion
- **Pooled fund products** — explicitly non-goal per master PRP
- **Chad rebuild** → PRP-12

## Deliverables

1. `@ap3x/portfolio` package with allocator + dedup + cross-strategy risk + wallet routing.
2. `ap3x-ops/` monorepo with dashboard app + alerting service.
3. Alert channel integrations working with real notifications to operator Telegram.
4. Replay tooling CLI + dashboard view.
5. Fill simulator recalibrated with 60+ days of live data; quarterly auto-recalibration job.
6. **Three concurrent strategies** running in production with clean allocation: one pump.fun DSL strategy, one Hyperliquid SDK strategy, one cross-vertical strategy.
7. **Control plane docs** — how to promote a strategy from paper to live, how approval tiers work in practice, how to respond to circuit breaker events.

## Acceptance criteria (gate — platform GA)

1. **Three strategies concurrent** — running live for 7 consecutive days, zero cross-contamination, zero platform-level incidents.
2. **Cross-strategy risk enforcement** — injection test: two strategies attempt simultaneous max-size buys on the same mint. Dedup merges; neither exceeds per-coin exposure cap.
3. **Wallet routing validated** — strategies in different wallets don't share risk budgets; verified via audit log.
4. **Kill switch still < 5s** even with three live strategies — measured during injection test.
5. **Dashboard live** — operator can see live state of all strategies, click through to audit log, run replay on any trade.
6. **Alert channels functional** — each alert class fires to Telegram under controlled test; acknowledged-alert tracking.
7. **Fill sim recalibration verified** — post-recalibration, backtest-vs-live PnL match within 10% (improved from 15% gate in PRP-04/06).
8. **Operator handoff doc** — a new operator can take over running the platform from docs alone.

## Key design decisions

- **Portfolio layer is additive.** Strategies don't know they're sharing capital; the allocator intercepts at the policy layer. Strategy code unchanged from PRP-08.
- **Order dedup at portfolio layer, not strategy.** Two strategies wanting the same mint don't need to coordinate; the portfolio layer merges their intents.
- **Shared kill switch, independent pause paths.** The platform-wide kill affects everything. Individual strategy pause affects one.
- **Dashboards are read-only.** Actions (pause, approve, promote) go through CLI or approval channels with audit trail, not dashboard buttons. Keeps the dashboard a safe surface.
- **Alerts are acknowledgeable.** Every alert has an ack flow; repeated alerts surface if unacked. Prevents alert fatigue blindness.
- **`ap3x-ops/` is its own repo** because it has different concerns (Next.js UI, web deploy, operator-facing) from the platform/vertical code. Operators may not need to touch `ap3x-platform/`; platform devs may not need to touch `ap3x-ops/`.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Three strategies reveal cross-contamination bugs not visible with one | Staged rollout: two strategies for 7 days, then three for another 7 |
| Dashboard UI becomes critical path; can't deploy changes without it | Keep dashboard read-only; actions never depend on dashboard uptime |
| Alert spam during active incidents | Rate limiting per alert class; ack-required deduplication; escalation chains |
| Fill sim recalibration makes backtests diverge from expected | Pin fill sim version in backtests; recalibration creates a new version; old strategies still validate against old fill sim |
| Portfolio allocator starves new strategies of capital while old ones hold | Time-bounded allocation review; a strategy holding a position > 7 days triggers review (configurable) |

## Post-PRP-09 landscape

**Platform GA** reached. Three verticals (pump.fun, Hyperliquid — PRP-10 adds Polymarket) × strategy runtime × portfolio × dashboards = a deployable multi-strategy agent platform that runs concurrent production strategies with operator oversight.

Acquisition demo at this point: operator runs `pnpm dash` → live strategies visible across pump.fun and Hyperliquid → run `pnpm backtest cross-vertical-momentum --days 30` → see attribution → click replay on any trade → see exact signal state at decision time → same code path ran in paper and live. That's a product.

## Next

On gate pass: platform GA. PRP-10 (Polymarket vertical) + PRP-12 (Chad rebuild) both unlock. PRP-11 is a template referenced by future vertical additions.

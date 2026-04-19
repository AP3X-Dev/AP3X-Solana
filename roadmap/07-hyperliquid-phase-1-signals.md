# PRP-07 — Hyperliquid vertical, Phase 1: Signal layer

**Repo:** `ap3x-hyperliquid/` (continues from PRP-06)
**Depends on:** PRP-06 (Hyperliquid foundation)
**Unblocks:** PRP-08 (strategy runtime)
**Estimate:** 3 weeks solo
**Validates:** `@ap3x/signals-core` framework under a second vertical. Second data point for the backtest harness.

## Goal

Ship the Hyperliquid **signal layer** — normalized liquidations, whale positions, smart money rankings, funding skew, buyer-side flow analysis. Ports + extends the Moondev Hyperliquid Data Layer concept under our platform framework. This is where Hyperliquid's "transparency-first" thesis meets our signal-versioning + as-of contract: every whale tag, every smart money label, every liquidation record is queryable with a time bound and a signal version pin.

## In scope

### Package `@ap3x/hyperliquid-event-store`

- Implements the `@ap3x/signals-core` event-store contract for Hyperliquid.
- Live tap from WS → Parquet + DuckDB (same pattern as pump.fun).
- Historical backfill from Hyperliquid's own historical API + paid archive sources where needed.
- Schema-versioned: trade events, liquidation events, funding events, position snapshot events (sampled every N minutes per user).
- Performance target: 90 days of Hyperliquid in < 200 GB compressed Parquet.

### Package `@ap3x/hyperliquid-signals`

**Base signals (cheap, from event store):**

- `getMarkets(asOf)` — all active coins with current spec + funding + oracle price at virtual time
- `getTrades(coin, asOf, window)` — trades with buyer/seller wallet tags
- `getCandles(coin, asOf, interval, count)` — OHLCV
- `getLiquidations(asOf, window, filter)` — liquidation events with wallet + size + coin + liquidation price
- `getFundingHistory(coin, asOf, window)` — funding rate time series
- `getUserState(user, asOf)` — positions, open orders, margin at virtual time (pinned to nearest snapshot)

**Derived signals — the Hyperliquid moat:**

- `whalePositions(asOf, filter)` — wallets with aggregate notional > $1M, time-sliced at `asOf`. 182 symbols supported (crypto + HIP-3 separate indices).
- `smartMoneyRank(asOf, window)` — top 100 by realized PnL in window vs bottom 100. Updated continuously; signal version pinned.
- `liquidationDanger(asOf, thresholdPct)` — open positions within N% of liquidation price across all users. Early-warning signal.
- `fundingSkew(coin, asOf, window)` — funding rate trajectory + concentration (are longs or shorts paying?); signals crowded positioning.
- `buyerFlow(coin, asOf, window, minSize)` — aggregate buy volume from wallets > $5k size (accumulation signal).
- `walletTag(user, asOf)` — multi-label: `whale`, `smart_money`, `chronic_liquidator`, `mm_strategy`, `hft`, `retail`. Derived from historical behavior; retrained on event store; version pinned.
- `crossExchangeDisagreement(coin, asOf)` — when Hyperliquid perp basis diverges from spot oracles on Binance/Bybit/OKX. Optional — requires external data ingestion.
- `hlpStrategy(asOf)` — introspection on Hyperliquid's own HLP market-making protocol ($210M+). Tracks HLP positioning + PnL.

**Fill simulator for `@ap3x/backtest`:**

Hyperliquid-specific fill model plugs into `@ap3x/backtest` framework:
- Orderbook reconstruction at `asOf` from book-update event stream
- Limit fill model: queue position estimation, time-priority, maker-fee rebate
- Market fill model: slippage against book depth at `asOf`
- Liquidation simulation: if position crosses liq price, liquidation mechanics enforced
- Funding accrual over holding period

Fill model is calibrated against 30 days of live execution data from PRP-06's reference strategy.

### Policy extensions

- Hyperliquid-specific circuit breakers plug into `@ap3x/policy`:
  - `liquidationApproaching` — any open position within X% of liq → pause new positions
  - `fundingAntagonistic` — funding rate on held positions exceeds threshold → alert
  - `hlpDrawdown` — HLP's own balance dropping signals systemic stress → pause

### Paper + shadow mode

Hyperliquid paper mode runs alongside live PRP-06 strategy — same code path, `submit_order` goes to paper backend instead of exchange. Divergence analysis over 14 days, same as pump.fun.

### Anti-cheat (inherited from `@ap3x/signals-core`)

- `asOf` enforced at query layer; fuzz test
- Signal versions pinned
- No wall-time access in backtest

## Out of scope

- **Strategy runtime / DSL** → PRP-08
- **Multi-exchange aggregation** (Binance, Bybit, OKX liqs that Moondev's API exposes) → post-GA, possibly separate vertical packages each
- **HIP-3 deep dive** (stocks, commodities, FX on Hyperliquid) → PRP-09 or post-GA
- **Social signal ingestion** — pump.fun optional social signals also not yet implemented; coordinated later

## Deliverables

1. Two packages built + tested.
2. 6 base signals + 8 derived signals operational with version pins, unit tests, query benchmarks.
3. Fill simulator for Hyperliquid perps calibrated from live data.
4. 14 days of paper mode running alongside PRP-06 reference strategy with divergence analysis.
5. Backtest harness runs end-to-end on Hyperliquid: `pnpm backtest <hl-strategy>` produces PnL + attribution + replay.
6. **Second validation report** (`ap3x-platform/docs/hyperliquid-signals-validation.md`) — evidence `@ap3x/signals-core` + `@ap3x/backtest` needed no Hyperliquid-specific modifications. Any needed changes trigger PRP-05.1.

## Acceptance criteria (gate)

1. **Backtest-vs-live PnL parity** on the PRP-06 reference strategy: 14-day backtest matches live PnL within 15%. Same bar as pump.fun had.
2. **Cross-vertical backtest determinism** — same inputs → bit-identical output; verified in CI. Same as pump.fun.
3. **Platform unmodified** — `@ap3x/signals-core` + `@ap3x/backtest` unchanged. Verified by grep + documented in validation report.
4. **Whale position tracking** — known whales (accounts > $10M notional) tracked correctly ≥95%; known MM strategies tagged correctly ≥85%.
5. **Liquidation danger signal** — emits alerts for 100% of positions that DID liquidate in the following 2 hours (on a 7-day holdout) — no false negatives.
6. **Smart money ranking stability** — 30-day rolling top-100 list shows <20% churn week-over-week on stable wallets; validates PnL computation is consistent.
7. **Signal query performance** — p95 of composite `getMarkets + getUserState + whalePositions` < 250ms on 90-day event store.

## Key design decisions

- **Two-vertical signal portfolio** — pump.fun signals (reputation, rugs, bundles) + Hyperliquid signals (liquidations, whales, funding) are archetypes for every future vertical's signal set. Polymarket's (PRP-10) will pattern-match.
- **Orderbook as the fill simulator target** — not pump.fun's bonding curve. Opposite end of the venue spectrum. If `@ap3x/backtest` framework supports both without modification, it supports most real venues.
- **HLP tracking as a free signal** — Hyperliquid's own market-maker vault is transparent; we include it because strategies benefit from knowing if the protocol's own liquidity is stressed.
- **Multi-exchange liquidations deferred.** Moondev's API aggregates Binance/Bybit/OKX; we don't reimplement this in PRP-07 because it requires separate venue integrations each worth their own PRP. Post-GA.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Hyperliquid data layer (underlying API) rate limits | Cache aggressively at signal layer; nightly diag monitors availability |
| Smart money rank volatility → spurious tag churn | Use rolling-window PnL with minimum sample sizes; version-pin aggressively |
| Whale position labels trigger reputation risk | Labels are signals for strategies, not published externally; no wallet data leaves the signal layer without explicit consumer action |
| Cross-exchange signals require separate venue integrations | Scoped out of PRP-07; flag for post-GA roadmap |
| Hyperliquid HIP-3 shape changes frequently | Separate schema + signal versioning for HIP-3 symbols vs native crypto; HIP-3 explicitly experimental |

## What this PRP proves

If `@ap3x/signals-core` + `@ap3x/backtest` support both pump.fun bonding-curve AMM + Hyperliquid orderbook perps with identical API shapes, the abstractions are validated for nearly any venue. The next vertical (Polymarket in PRP-10) becomes a ~2-3 week vertical addition, not a 12-week per-vertical reimplementation.

This is the payoff of PRP-05's extraction work.

## Next

On gate pass: PRP-08 (strategy runtime + SDK) unlocks.

# PRP-10 — Polymarket vertical

**Repo:** `ap3x-polymarket/` (NEW)
**Depends on:** PRP-05 (platform extraction) at minimum; PRP-09 for the full portfolio + dashboards experience
**Can run in parallel with PRP-08/PRP-09 after PRP-05 lands.**
**Estimate:** 2-3 weeks solo
**Reference:** Chad's existing Polymarket integration (`packages/chat-core/src/polymarket/`, `packages/integrations/src/polymarket/`) — source for this vertical, not starting from zero.

## Goal

Third vertical. Prediction markets (Polymarket) join the platform. Lighter scope than pump.fun or Hyperliquid because:
- The Polymarket Gamma + CLOB clients already exist in Chad (PRP-1 work)
- No on-chain transaction machinery needed at this scale (Polymarket's CLOB is off-chain)
- Prediction-market signals are narrower than perps or bonding curves

By PRP-10 completion, a strategy author can deploy the same DSL/SDK strategy format against pump.fun, Hyperliquid, OR Polymarket by just swapping the tool binding.

## In scope

### Package `@ap3x/polymarket-connectivity`

Lifts from Chad's `packages/integrations/src/polymarket/client.ts`:
- Gamma API typed client (markets, events, tags, sports, search)
- CLOB API typed client (orderbook, trades)
- `clobTokenIds` direct path (already solved in Chad's POLYMARKET_CLOB_TOKEN_IDS_FIX.md)
- WebSocket subscription for live orderbook updates
- EIP-712 signing for market orders (same vault abstraction as Hyperliquid — proof the vault is genuinely multi-chain)

### Package `@ap3x/polymarket-protocol`

- Typed market + event metadata models
- Outcome pricing helpers
- `pricesToProbability` / `probabilityToPrices` conversion primitives (markets are priced in outcome tokens)

### Package `@ap3x/polymarket-exec`

- Order builders: `buildLimitOrder`, `buildMarketOrder` (FOK/IOC options)
- Simulation via orderbook snapshot
- Submission via Polymarket CLOB endpoint
- Cancellation + partial-fill tracking

### Package `@ap3x/polymarket-event-store`

Implements `@ap3x/signals-core` contract for Polymarket:
- Live tap from WS: trade events, book updates, new-market events, market-close events
- Historical backfill from Gamma API
- Schema: one row per Polymarket trade + one row per book update

### Package `@ap3x/polymarket-signals`

**Base:**
- `getMarket(marketId, asOf)` — full market state
- `getOrderbook(tokenId, asOf)` — book snapshot
- `getTrades(marketId, asOf, window)`
- `getNewMarkets(since, filter)` — new-market stream

**Derived (prediction-market-specific):**
- `impliedProbability(marketId, asOf)` — consensus probability from last-traded price
- `liquidityDepth(marketId, asOf)` — depth at N basis-points each side
- `sharpBookFlow(marketId, asOf, window)` — detect informed-buyer behavior in flow
- `marketResolutionConfidence(marketId, asOf)` — composite of liquidity + time-to-resolution + whale positioning
- `sportsLineAlignment(marketId, asOf)` — for sports markets, compare to sportsbook consensus (optional external data)
- `walletTag(user, asOf)` — `sharp`, `casual`, `known_oracle`, `resolver_friend`, `insider`

**Fill simulator for `@ap3x/backtest`:**
- CLOB orderbook reconstruction at `asOf`
- Queue position estimation for limit orders
- IOC / FOK fill semantics
- Market-close handling (positions settle automatically)

### Policy extensions

- Polymarket-specific caps: `per_market_exposure_usdc`, `max_open_markets`, `max_holding_time_days` (markets close eventually)
- Circuit breakers: market-paused-by-Polymarket triggers position review; oracle-disagreement flag

## Out of scope

- **Sports book adjacent integrations** (Polymarket is prediction markets; direct sports books like FanDuel are a separate vertical at post-GA)
- **Polymarket-specific DSL extensions** — the generic DSL from PRP-08 should suffice; if not, it's a signal the DSL needs refinement, not that Polymarket needs its own
- **Migration of Chad's existing Polymarket widget** — that's PRP-12 (Chad rebuild)

## Deliverables

1. Five packages built + tested (connectivity, protocol, exec, event-store, signals).
2. One reference strategy: `examples/polymarket-sharp-follow/` — places IOC buys when `sharpBookFlow` detects informed buying on markets with `marketResolutionConfidence > 0.8`.
3. Event store + fill sim calibrated from 30 days of live Polymarket data.
4. Backtest → paper → shadow → live pipeline works for Polymarket same as for other verticals.
5. **Third validation report** — `ap3x-platform/docs/polymarket-validation.md`. Should show minimal platform modifications needed since this is a well-trodden path now.

## Acceptance criteria (gate)

1. **Vertical contract conformance** — all five packages pass `verifyVerticalContract(impl)`.
2. **Backtest-vs-live PnL parity** — 14-day backtest of reference strategy matches live within 15%.
3. **Reference strategy running** — 14 days live on $100 cap with complete audit trail.
4. **DSL portability** — a DSL strategy written for pump.fun runs unmodified against Polymarket signals after tool binding swap. (Smoke test of the cross-vertical claim.)
5. **Zero platform package modifications** — verified by grep. Polymarket was a walk in the park because the platform was designed for this.
6. **Third vertical onboarding cost** — measured: from repo-scaffold to reference-strategy-live ≤ 3 weeks solo (target was 2-3).

## Key design decisions

- **Lift from Chad, don't start from zero.** Chad's Polymarket code is mature (clobTokenIds bug already fixed, widget integration exists). We translate + restructure into the platform pattern rather than rebuild.
- **Polymarket is the "easy" vertical.** It validates that the platform scales to additional verticals at 2-3 weeks cost, not 12. If this takes longer, something regressed in the abstractions.
- **No new policy concepts.** Polymarket's risk dimensions map cleanly onto cap frameworks already in `@ap3x/policy`. If they don't, fix the framework — don't Polymarket-ize it.
- **Shared vault abstraction.** Polymarket uses EIP-712 like Hyperliquid, but the vault abstraction already supports it. Second confirmation the vault is chain-agnostic.
- **HIP-3 pattern carries over.** Polymarket's sports markets + politics markets + science markets all use the same CLOB infrastructure. Tag them in signals for strategy filtering; don't fragment the vertical.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Polymarket API rate limits | Cache + batch similar to pump.fun |
| Market resolution disputes | Wallet-tag `resolver_friend` signal; strategies can avoid disputed markets; hard-code blacklist of known-disputed markets |
| Low-liquidity markets skew backtest | Fill sim includes "would this size move the market?" — prevents over-fit on thin markets |
| Polymarket regulatory exposure | Platform-as-infrastructure stance; same pose as pump.fun |
| User wants to run only Polymarket without other verticals | Platform supports this (vertical packages are independent); no coupling between verticals |

## What this PRP confirms

If PRP-10 ships cleanly in 3 weeks with zero platform modifications, the AP3X platform thesis is proven out for any venue with:
- A public API (REST, WS, or gRPC)
- A concept of "markets" (coins, tokens, events, whatever)
- A concept of "actions" (orders, bets, swaps)
- Enough data to derive signals

That set includes: every CEX (Binance, Coinbase, Kraken, Bybit, OKX), every on-chain DEX (Uniswap, Curve, Aerodrome), NFT marketplaces (Magic Eden, Tensor, OpenSea), sports books, prediction markets, TradFi APIs (Alpaca, Interactive Brokers), even non-financial venues (fantasy sports, esports tips).

PRP-11 is the template for future vertical additions.

## Next

On gate pass: third vertical live. PRP-12 (Chad rebuild) and any future PRP-11 instantiation can proceed.

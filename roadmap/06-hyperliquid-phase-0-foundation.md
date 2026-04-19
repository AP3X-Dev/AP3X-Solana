# PRP-06 — Hyperliquid vertical, Phase 0: Foundation

**Repo:** `ap3x-hyperliquid/` (NEW)
**Depends on:** PRP-05 (platform extraction complete)
**Unblocks:** PRP-07 (Hyperliquid signal layer)
**Estimate:** 3-4 weeks solo
**Validates:** Platform abstractions extracted in PRP-05. If this PRP needs to modify any platform package, that's a signal the abstraction is wrong.
**Reference:** [moondevonyt/Hyperliquid-Data-Layer-API](https://github.com/moondevonyt/Hyperliquid-Data-Layer-API) — Python implementation; we rewrite in TypeScript under our license (verify AGPL/MIT before lifting).

## Goal

Ship the Hyperliquid vertical's **read + execute foundation** implementing the `@ap3x/vertical` contract from PRP-05. Hyperliquid is the maximally-different second vertical: perps orderbook instead of bonding curve, REST+WebSocket instead of Geyser, own L1 instead of Solana, position-centric instead of token-centric. If the platform can host both pump.fun and Hyperliquid cleanly, the abstractions are validated.

## In scope

### Package `@ap3x/hyperliquid-connectivity`

- **REST client** — Hyperliquid info endpoint + user state + markets metadata. Typed responses; zod schemas validate + future-proof against upstream shape drift.
- **WebSocket subscription manager** — `subscribe({ type: "trades", coin }) | { type: "bookUpdates", coin } | { type: "userEvents", user } | { type: "webData2" }`. Backpressure, gap detection, reconnect with resubscribe.
- **Event normalization** — Hyperliquid WS events → platform `EventEnvelope` shape. Every event has `slot` (use block-height-equivalent), `block_time`, `sig` (use order/trade id), `event_type`, `payload`. Plugs into `@ap3x/signals-core`'s event store (PRP-07).
- **Key management** — Hyperliquid uses EIP-712 signing for L1 actions. Implement using `@ap3x/vault` (from PRP-05) as the secret store + domain-specific signer on top. No raw private key in memory after unlock.
- **Account state reader** — typed snapshots: positions (coin, size, entry px, leverage, unrealized PnL), open orders, fills history, withdrawals, margin summary.

### Package `@ap3x/hyperliquid-exec`

- **Order builder** — one struct per order variant: `LimitOrder`, `MarketOrder`, `StopOrder`, `TakeProfitOrder`. No raw L1 action payloads exposed.
- **Simulation** — pre-flight state check via info endpoint: would this order trigger margin call? exceed leverage? cross an open position? Returns a receipt per `@ap3x/policy` contract. TTL same as pump.fun (10s default).
- **Submission path** — builds L1 action payload, signs via `@ap3x/vault` handle, submits via exchange endpoint, tracks order id → fill via WS user events subscription.
- **Cancellation** — `cancelOrder(orderId)` with idempotent semantics.
- **Position management primitives** — `reducePosition(coin, size)`, `closePosition(coin)` that internally place the right order type. No strategy-facing access to raw order types unless they opt into them explicitly.

### Package `@ap3x/hyperliquid-protocol`

- **Typed market metadata** — for each coin: contract spec, tick size, lot size, max leverage, funding rate history (24h), oracle price, min order size
- **Funding rate reader** — current + historical funding; per-coin + aggregated
- **Position math** — `notionalFromSize(size, markPrice)`, `marginRequired(notional, leverage)`, `liquidationPrice(entry, size, margin)`. Pure functions, unit-tested against Hyperliquid's own formulas.
- **Event decoder** — WS event variants → typed records. Exhaustive match. Unknown variants surface as `UnknownEventDecode` (same pattern as pump.fun).

### Reference example

- **`ap3x-hyperliquid/examples/hl-watch/`** — Node script that subscribes to a user's positions + all BTC trades, prints typed records with latency measurement. Analog of `pumpfun-watch` from PRP-02.

### Policy integration

- Pump.fun-style tool schemas adapted to Hyperliquid surface: `simulate_limit`, `simulate_market`, `submit_order`, `cancel_order`, `reduce_position`, `close_position`, `get_positions`, `get_open_orders`, `get_fill_history`, etc.
- These live in a new `@ap3x/hyperliquid-policy` package that imports `@ap3x/policy` from the platform.
- Hyperliquid-specific risk dimensions: `per_position_leverage`, `aggregate_leverage`, `per_coin_position_cap`, `funding_rate_tolerance` (strategies opt out of positions when funding crosses threshold). Added to the cap framework defined in `@ap3x/policy`.
- Circuit breakers: liquidation-distance alarm (pause when any open position is < X% from liq), funding-rate-disagreement between two Hyperliquid API endpoints, WS subscription gap > threshold.

## Out of scope

- **Signal layer** (liquidations, whales, smart money tags, funding skew) → PRP-07
- **Backtest harness for Hyperliquid** — leverages `@ap3x/backtest` framework from PRP-05 but fill model for orderbook-style perps is PRP-07
- **Strategy runtime / DSL / SDK** → PRP-08
- **HIP-3 instruments** (stocks, commodities, FX via Hyperliquid) → post-GA
- **Multi-exchange** (Binance, Bybit, OKX aggregated via Moondev's API) → post-GA; potentially a separate vertical each

## Deliverables

1. `ap3x-hyperliquid/` monorepo created with same skeleton as the other two.
2. Four packages above built + tested.
3. Example app `hl-watch` operating continuously for 1 hour with latency measurement.
4. One hardcoded reference strategy operating on small live capital (≤ $50 notional, testnet-first, mainnet with 1x leverage only).
5. Hyperliquid-specific policy + cap schema documented in `ap3x-hyperliquid/docs/policy.md`.
6. **Platform abstraction validation report** (`ap3x-platform/docs/hyperliquid-validation.md`) — documents every place where `@ap3x/vertical`, `@ap3x/policy`, `@ap3x/vault`, or `@ap3x/signals-core` needed modification to support Hyperliquid. Modifications that surface here feed back into a PRP-05.1 follow-up pass.

## Acceptance criteria (gate)

1. **Vertical contract conformance** — `@ap3x/hyperliquid-connectivity` + `@ap3x/hyperliquid-exec` + `@ap3x/hyperliquid-protocol` all pass `verifyVerticalContract(impl)`.
2. **Event ingestion working** — `hl-watch` captures every trade + user event for 1h continuous with p50 < 500ms, p99 < 2s.
3. **Live reference strategy** — 48 hours of live execution on testnet + 24h on mainnet (1x leverage, $50 cap) with zero out-of-budget writes, complete audit log.
4. **Policy enforcement** — Hyperliquid-specific caps (leverage, liquidation distance) verified by injection test.
5. **Platform unmodified** — every platform package (`@ap3x/policy`, `@ap3x/vault`, `@ap3x/signals-core`, `@ap3x/backtest`, `@ap3x/vertical`) emerges from this PRP with zero code changes required. If any change was needed, it's documented in the validation report and a PRP-05.1 refactoring PRP follows.
6. **Zero Hyperliquid-specific code in `ap3x-platform/`** — the abstractions extracted in PRP-05 proved sufficient. Verified by grep.

## Key design decisions

- **Maximally-different vertical on purpose.** Hyperliquid is chosen because it stress-tests the abstractions. If we could get away with a Solana-similar vertical (e.g., Orca, Meteora) the validation would be weaker.
- **Testnet before mainnet for reference strategy.** Hyperliquid testnet is generous; burn bugs there. Mainnet trial starts at 1x leverage + $50 caps.
- **EIP-712 signing in the vault.** Vault from PRP-05 is chain-agnostic — Solana keypair and Ethereum keypair both live behind the same `WalletHandle` interface. This tests the vault abstraction.
- **Moondev's Python code is reference, not source.** License check required first. If AGPL, we study architecture + rewrite in TS; if MIT or similar compatible, we lift selectively. Either way, final code is ours under our license.
- **Validation report is deliverable 6.** The most valuable output of this PRP isn't the Hyperliquid code — it's the evidence that the platform abstractions hold under stress. That report drives any PRP-05.1 cleanup.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Platform abstractions require changes to support Hyperliquid | Document in validation report, cut a PRP-05.1 refactor pass, accept schedule impact |
| Hyperliquid API surface changes mid-PRP | Zod validation layer catches shape drift; nightly diag probe like Chad has |
| Perps-specific risk math errors lose real money | Testnet-first discipline; mainnet capped at $50 + 1x leverage; liquidation-distance breaker with conservative threshold |
| EIP-712 signing complexity | Use `@noble/secp256k1` + `@noble/hashes` — MIT-licensed, audited, single-purpose crypto primitives (allowed exception to zero-dep, same as `libsodium-wrappers` for Solana) |
| Moondev code license incompatible | Don't use it directly; study architecture, implement independently. Reference repo is for signal-layer inspiration in PRP-07, not direct lift |

## Validation report template (for `ap3x-platform/docs/hyperliquid-validation.md`)

```markdown
# Platform abstraction validation against Hyperliquid

## Modifications required
- [list any `@ap3x/policy`, `@ap3x/vault`, `@ap3x/signals-core`, `@ap3x/backtest`, `@ap3x/vertical` changes needed]

## Workarounds
- [list any Hyperliquid-specific hacks that shouldn't be there]

## Confirmed abstractions
- [list abstractions that held cleanly]

## Recommendation
- [PRP-05.1 refactor pass needed? Y/N with specifics]
```

## Next

On gate pass: PRP-07 (Hyperliquid signal layer) unlocks.
If validation report flags serious abstraction issues: PRP-05.1 refactor pass before PRP-07 proceeds.

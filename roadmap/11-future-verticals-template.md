# PRP-11 — Future vertical template

**Use this as the PRP template for any new vertical added to the platform after pump.fun, Hyperliquid, and Polymarket are live.**

This is not an implementation PRP — it's a reusable specification document for any future vertical. Each instantiation (Magic Eden NFT, Binance perps, sports-betting books, prediction markets, TradFi, non-crypto verticals) forks this template and fills in the venue-specific details.

## Candidate verticals

Prioritized by order-of-magnitude fit with the platform:

| Vertical | Category | Difficulty | Strategic value |
|---|---|---|---|
| **Magic Eden NFT trading** | NFT marketplace | Medium | Solana NFT activity is large + underserved by agent infrastructure |
| **Tensor (Solana NFT)** | NFT marketplace | Medium | Tensor is the pro-trader NFT venue; high alpha per trade |
| **Binance perps** | CEX perps | High (rate limits, keys, tax jurisdictions) | Massive liquidity; proves CEX pattern works |
| **Bybit / OKX perps** | CEX perps | High | Follow-on to Binance; similar infra |
| **Uniswap (EVM DEX)** | On-chain DEX | Medium-High | EVM ecosystem proves the chain-agnostic vault works beyond Hyperliquid |
| **Base / Arbitrum DEXes** | L2 DEX | Medium | Same as above |
| **Jupiter aggregator** | Solana DEX aggregator | Low | Already partially integrated in Chad; minimal new work |
| **Raydium / Orca / Meteora** | Solana DEXes | Medium | Natural follow-on to pump.fun; shared Solana infra |
| **Coinbase Advanced Trade** | CEX spot | Medium | US-facing; legal + tax implications |
| **Sports-betting books** (DraftKings, FanDuel, BetMGM via unofficial APIs) | Sports | Very high (legal, terms-of-service risk) | Alpha exists; massive TAM; regulatory risk |
| **Kalshi / Manifold prediction markets** | Prediction markets | Low-Medium | CFTC-regulated; easier to justify legally |
| **Alpaca** (TradFi stock brokerage API) | TradFi | Medium | Proves non-crypto works; opens equities + options |
| **Interactive Brokers API** | TradFi | High (but proven SDK available) | Institutional-grade TradFi |
| **Fantasy sports (Sleeper, Underdog)** | Fantasy | Medium | Non-financial venue; proves the platform isn't just trading |

Strategic picks for next 12 months after platform GA:
1. **Magic Eden** (validates NFT vertical pattern; natural next for Solana focus)
2. **Binance perps** (validates CEX pattern)
3. **Kalshi** (validates regulatory-lighter prediction markets; complements Polymarket)

## Standard vertical PRP structure

Every vertical PRP forked from this template must include the following sections. Fill with venue-specific content.

### 1. Goal

Ship the <vertical> vertical on the AP3X platform: connectivity, typed protocol, signals, execution, fill simulator. Implements `@ap3x/vertical` contract. End-state: a strategy written against `@ap3x/strategy` DSL or SDK can target this venue without modification.

### 2. Why this vertical

Market size + alpha density + strategic fit. Why is this worth a PRP before alternatives on the candidate list?

### 3. Repo + packages

- Monorepo: `ap3x-<vertical-slug>/`
- Minimum 4 packages: `*-connectivity`, `*-protocol`, `*-exec`, `*-signals`
- Optional: `*-event-store` if the vertical has a distinct storage pattern; otherwise uses `@ap3x/signals-core` directly

### 4. Venue-specific details

- API surface (REST, WS, gRPC, etc.)
- Auth model (API keys, OAuth, wallet signatures, etc.)
- Rate limits (real numbers from the provider's docs)
- Data format peculiarities
- Geographic / regulatory constraints (US vs non-US, KYC requirements, etc.)

### 5. Platform contract conformance

- `@ap3x/vertical` interfaces this vertical implements (all of them)
- Deviations or extensions — documented explicitly
- If this vertical needs platform modifications, flag early and consider postponing until a PRP-05.X refactor pass can accommodate

### 6. Signal definitions (base + derived)

- Mirror the structure of pump.fun/Hyperliquid/Polymarket signals
- Identify what's venue-specific vs what reuses existing platform signals
- Version every derived signal from day one

### 7. Fill model

- What does a fill look like on this venue?
- What's the realistic latency distribution?
- What failure modes exist? (Rejected orders, partial fills, API downtime, etc.)

### 8. Policy extensions

- Venue-specific caps + circuit breakers
- Always extend `@ap3x/policy`; never create a parallel policy engine

### 9. Reference strategy

- One strategy, deployed to live with small capital after paper + shadow validation
- Uses `@ap3x/strategy` DSL or SDK
- Demonstrates at least one venue-specific signal in action

### 10. Acceptance criteria (gate)

- Vertical contract conformance passes
- Reference strategy runs live 7+ days
- Backtest-vs-live PnL within 15%
- Platform package modifications required: ideally 0
- Cross-vertical strategy demo: a pre-existing strategy from another vertical runs against this one after tool binding swap

### 11. Timeline estimate

- Target: 2-3 weeks if the platform is mature enough (post-PRP-10)
- Longer estimates flag where the platform needs work, not where the vertical is complex

### 12. Risks + open questions

- Legal / ToS risk if applicable (sports books, some TradFi APIs)
- Rate limit / access risk
- Data availability for historical backfill
- Key custody for authenticated venues

## When NOT to add a vertical

Not every venue belongs on the platform. A vertical should be declined if:

- **Regulatory exposure too high** for current platform posture (platform-as-infrastructure defense depends on avoiding custodial fund management)
- **Data surface too proprietary** — if the venue's data is behind a paywall we can't afford, the signal layer can't compete
- **Strategy alpha too thin** — no point building a vertical where the best-case Sharpe is 0.2
- **Vertical abstractions don't fit** — if implementing this vertical requires platform modifications, the template is wrong for it OR it's actually a different kind of integration (research? back-office? ops tooling?)
- **Operator capacity full** — running three verticals is operational work; adding a fourth before auto-ops matures burns out the operator

## Approval pipeline for new vertical PRPs

1. Proposer forks this template and drafts a vertical PRP.
2. Estimated effort + strategic value reviewed against the candidate list above.
3. If approved, vertical PRP gets a number (PRP-12, PRP-13, etc.) and joins the roadmap.
4. Implementation follows the standard brainstorm → spec → plan → implementation flow.

## Example: if we added Magic Eden tomorrow

The PRP would be:
- **Goal:** ship Magic Eden vertical (NFT trading on Solana)
- **Repo:** `ap3x-magiceden/`
- **Packages:** `@ap3x/magiceden-connectivity` (REST + WS), `@ap3x/magiceden-protocol` (NFT types + collections), `@ap3x/magiceden-exec` (buy/list/bid/cancel), `@ap3x/magiceden-signals` (floor tracking, whale buyer detection, collection momentum, rarity-adjusted pricing)
- **Novelty vs platform:** NFT is the first non-fungible vertical; the `@ap3x/signals-core` event store needs to handle per-asset events (not just per-market). Platform modification likely required: generalize event store from `market_id` to `instrument_id` with type tag.
- **Estimate:** 3 weeks
- **Cross-vertical demo:** a pump.fun strategy triggers Magic Eden NFT buys when specific dev wallets drop new collections.

That PRP fills in the template above and joins the roadmap.

## Next

Use this template when a new vertical is proposed. Platform-GA status enables rapid vertical onboarding.

# AP3X Platform Roadmap

**Thesis.** AP3X is an agent platform with vertical adapters — not a Solana-specific product, not a trading bot, not a single app. `@ap3x/core` is the vertical-agnostic runtime (competes with LangGraph). A small set of **cross-cutting packages** (policy, strategy runtime, backtest harness, portfolio) form the substrate every vertical plugs into. **Verticals** are concrete venue integrations (pump.fun, Hyperliquid, Polymarket, eventually non-crypto books) that ship the same interface contract — connectivity + protocol/data + signal layer + execution — so strategies and tooling transfer across them.

Chad GPT is the first proof-of-concept consumer app. PRP-1 shipped it. Going forward, **Chad evolves as the platform evolves** — each vertical/platform package that lands gets adopted by Chad, demonstrating the stack end-to-end. Chad is never the product; the platform is.

## Repo topology

```
ap3x-core/                  existing, published.
                            @ap3x/core — agent runtime, zero-dep.

ap3x-platform/              NEW monorepo. Vertical-agnostic substrate.
                            @ap3x/policy, @ap3x/signals-core,
                            @ap3x/strategy, @ap3x/backtest,
                            @ap3x/portfolio, @ap3x/vertical

ap3x-solana/                NEW monorepo. Solana + pump.fun vertical.
                            @ap3x/solana-connectivity,
                            @ap3x/solana-tx,
                            @ap3x/pumpfun-protocol,
                            @ap3x/pumpfun-signals

ap3x-hyperliquid/           NEW monorepo. Hyperliquid vertical
                            (validates platform abstractions).
                            @ap3x/hyperliquid-connectivity,
                            @ap3x/hyperliquid-exec,
                            @ap3x/hyperliquid-signals

chad-gpt/                   existing. PRP-1 shipped. Consumer app.
                            Becomes reference implementation of the
                            platform over time. No separate PRP — Chad
                            absorbs platform packages as they land.
```

## PRP index

Each file below is an actionable spec ready for implementation. They build a single continuous timeline: PRP-02 starts after PRP-1 (Chad foundation). Every PRP has its own gate; no PRP ships until its gate passes.

| # | PRP | Weeks | Ships |
|---|---|---|---|
| **00** | [Master platform PRP](./00-master-platform-prp.md) | — | The canonical platform + pump.fun vertical spec (vision doc, not an implementation slot) |
| **01** | [Solana substrate](./01-solana-substrate.md) | 2-3 | `@ap3x/solana-*` — generic Solana agent toolkit independent of any venue: RPC pool + Geyser, v0 tx builder + priority fees + Jito bundle builder, SPL + Metaplex parsers, generic event decoder framework, encrypted keypair vault. Standalone publishable asset. |
| **02** | [Pump.fun protocol](./02-pumpfun-protocol.md) | 1-2 | `@ap3x/pumpfun-*` — first Solana vertical on the substrate: pump.fun program decoders, bonding curve math, typed read-only client, advanced-api-v2 compat wrapper (lifted from Chad's pump-gateway). Validates the substrate abstractions. |
| **03** | [Pump.fun Phase 1 — execution + safety](./03-pumpfun-phase-1-execution-safety.md) | 3 | Write path (simulate, receipts, submit), Jito bundle dispatcher, pump.fun-specific policy engine, circuit breakers, kill switch, one hardcoded strategy live. |
| **03.5** | [Pump.fun advanced tooling](./03.5-pumpfun-advanced-tools.md) | 1-2 | Vanity mint addresses, atomic launch-and-snipe bundles, metadata + authority revocation, airdrop distribution. Power-user tooling that rides PRP-03's safety rails. |
| **03.6** | [Multi-wallet OpSec](./03.6-multi-wallet-opsec.md) | 2-3 | `@ap3x/wallet-pool` (role-based N-wallet management), `@ap3x/hop-router` (SOL-only hop routing between owned wallets), `DistributedStrategy` primitive, scheduled address rotation. Legitimate OpSec capability; explicitly not anti-detection tooling. |
| **04** | [Pump.fun Phase 2 — signal layer](./04-pumpfun-phase-2-signal-layer.md) | 4 | Event store (Parquet + DuckDB), base signals, derived signals (dev reputation, smart money, bundle detection, graduation ETA), virtual clock + backtest harness. |
| **04.5** | [Clustering + entity intelligence](./04.5-clustering-entity-intel.md) | 3 | Wallet-graph clustering (transfer, common-funding, behavioral, CEX-withdrawal, bundle co-occurrence), role-based entity labels, fund-flow tracing, composite rug scorecard. Replicates Bubblemaps / Arkham / Chainalysis as signals every strategy queries. |
| **05** | [Platform extraction](./05-platform-extraction.md) | 1-2 | Extract vertical-agnostic abstractions out of pump.fun into `ap3x-platform`: `@ap3x/policy`, `@ap3x/signals-core`, `@ap3x/clustering-core`, `@ap3x/wallet-pool`, `@ap3x/backtest`, `@ap3x/vertical` interface contract. No functional changes; refactoring + tests. |
| **06** | [Hyperliquid Phase 0 — foundation](./06-hyperliquid-phase-0-foundation.md) | 3-4 | Hyperliquid REST+WS connectivity, typed client, event normalization. Second vertical start — validates platform abstractions. |
| **07** | [Hyperliquid Phase 1 — signals](./07-hyperliquid-phase-1-signals.md) | 3 | HL-specific signals (liquidations, whale positions, funding skew, smart money rankings), plugged into `@ap3x/signals-core`. Second signal layer validates the framework. |
| **08** | [Strategy runtime + SDK](./08-strategy-runtime-sdk.md) | 4 | `@ap3x/strategy`: declarative DSL compiler + agentic TypeScript SDK + strategy registry + shadow mode. External authors write a pump.fun OR Hyperliquid strategy without caring which vertical. |
| **09** | [Portfolio + lifecycle](./09-portfolio-lifecycle.md) | 3-4 | Capital allocator, cross-strategy risk, wallet routing, dashboards, alerting, replay tooling. Three+ strategies running concurrently with clean allocation. |
| **10** | [Polymarket vertical](./10-polymarket-vertical.md) | 2-3 | Third vertical, repurposed from Chad's existing Polymarket integration. Prediction markets join the platform. Lighter scope because data surface is simpler and many primitives exist. |
| **11** | [Future verticals template](./11-future-verticals-template.md) | — | Template PRP documenting what any new vertical must ship to join the platform. Referenced by future vertical PRPs (Magic Eden NFT, Binance perps, sports-betting books, prediction markets, TradFi APIs, non-crypto). |
| **12** | [Chad platform rebuild](./12-chad-platform-rebuild.md) | 2-3 | Chad's current inline integrations replaced with platform-vertical consumers. Chad becomes the "runs on the AP3X platform" reference app — not a separate product. |

**Timeline estimate, sequential execution:** PRP-01 through PRP-09 ≈ 31-38 weeks (base 25-30 plus ~6-8 weeks for the three interstitial PRPs 03.5 / 03.6 / 04.5). PRP-10 + PRP-12 add ~5-6 weeks. **Total program: ~8-10 months** to full platform GA with three verticals, the defensive/research intelligence stack, and Chad rebuilt. Non-crypto vertical additions continue as PRP-11 template instantiations after that.

**Parallel execution** shrinks this substantially: PRP-03.5 and PRP-03.6 can run in parallel with PRP-04 (the signal layer) once PRP-03 lands; PRP-04.5 can start as soon as PRP-04's event store is operational; PRP-06/07 (Hyperliquid) can start as soon as PRP-05 lands; PRP-08 (strategy runtime) can run in parallel with PRP-06/07; PRP-10 (Polymarket) needs only PRP-05 done; any Solana-venue vertical (Raydium, Orca, Magic Eden) can start as soon as PRP-01 lands. With two agents or a contributor, the program can compress to 5-6 months.

## Ordering rationale

- **01** = Solana substrate first and independently. `@ap3x/solana-*` is a publishable asset on its own merit; any Solana-venue vertical (pump.fun, Raydium, Orca, Magic Eden, Jito) consumes it. Validates the "Solana + agents ecosystem" positioning concretely from PRP-01's completion, without pump.fun being a dependency.
- **02 → 03 → 04** = pump.fun as the first full vertical on the substrate. Shipped vertically-integrated, validated end-to-end with one real strategy. Resist premature abstraction — build the specifics first.
- **03.5** = pump.fun operator tooling (vanity addresses, launch+snipe bundles, metadata + authority, airdrops) that rides PRP-03's safety rails. Ships alongside pump.fun's trading path because launch operators need these capabilities inside the policy + audit surface, not in third-party tools.
- **03.6** = multi-wallet OpSec primitives (WalletPool, HopRouter, DistributedStrategy, rotation) — legitimate capability for treasury management, strategy IP protection, and operational security. Explicitly scoped to "route SOL between owned wallets" and "run one strategy across N wallets"; does not ship anti-detection meta-strategies.
- **04.5** = on-chain clustering + entity intelligence (transfer-graph + behavioral + CEX-withdrawal clustering, role-based labels, fund-flow tracing, composite rug scorecard). Replicates Bubblemaps / Arkham / Chainalysis capability as signals every strategy queries. The defensive counterpart to 03.6.
- **05** = extract vertical-agnostic abstractions ONLY after pump.fun forces them to exist concretely. Refactoring, not design-up-front. Primary extraction targets: `@ap3x/clustering-core` (from 04.5), `@ap3x/wallet-pool` (from 03.6), `@ap3x/policy` (from 03), `@ap3x/signals-core` + `@ap3x/backtest` (from 04), `@ap3x/vertical` interface contract.
- **06 → 07** = Hyperliquid as the validation test. If the extracted abstractions work here (maximally different venue: perps orderbook vs bonding curve, REST+WS vs Geyser), they'll work for anything.
- **08** = strategy runtime AFTER two verticals exist. The DSL and SDK surface need two data points to be right. Skipping this wait means shipping a strategy API that's secretly pump.fun-specific.
- **09** = portfolio layer after strategies have somewhere to run. Capital allocation with zero strategies is premature.
- **10, 11** = additional verticals are fast once the pattern is proven. Each one just implements the vertical contract.
- **12** = Chad rebuild at the end because Chad's only value is as a showcase, and the platform needs to be worth showcasing first.

## Out of scope for this roadmap

- Control plane (deployment pipelines, approval UI, strategy registry SaaS) — ops infrastructure, separate program post-GA
- Public SDK marketing, developer docs site, onboarding flow — product marketing
- Compliance + legal review — concurrent but outside this engineering spec
- Custodial fund management, pooled capital products — explicitly excluded per platform PRP
- Governance / open-source strategy (which packages go MIT vs closed-source) — product decision, not engineering

## Authoring notes

- Authored: 2026-04-19 (post PRP-1 merge)
- Author: CJ (AP3X)
- Commitments: non-AI-attributed commits in all platform repos (per CLAUDE.md global rules). `@ap3x/*` namespace on npm (user-owned scope).
- Every PRP in this roadmap starts its own brainstorming → spec → plan cycle when picked up. This document is the master index; individual PRPs produce implementation plans when execution begins.

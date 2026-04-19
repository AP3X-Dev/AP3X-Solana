# PRP-12 — Chad GPT platform rebuild

**Repo:** `chad-gpt/` (existing — stays put)
**Depends on:** PRP-09 (portfolio + lifecycle — platform at GA)
**Can run in parallel with PRP-10.**
**Estimate:** 2-3 weeks solo
**Predecessor:** PRP-1 (Chad foundation — shipped)

## Goal

Rebuild Chad as a **reference consumer app on the AP3X platform**. Chad stops being a self-contained product with inline integrations; it becomes a thin shell over the full platform stack — a chat UI + widget surface that composes platform primitives. The end state: Chad demonstrates the platform to every user who types into the chat bar; every widget, every analysis, every trade is a demo of an `@ap3x/*` package in action.

Chad's value after this PRP is 100% as a showcase. If someone wants to understand "what does this platform actually do?" — they run Chad and talk to it.

## In scope

### Chad migrations (existing Chad components → platform consumers)

**`packages/integrations/src/helius/`** → consumed via `@ap3x/solana-connectivity`
- Drop Chad's inline Helius client
- Chad's nodes that need Solana RPC call `@ap3x/solana-connectivity.rpc` instead
- Delete `packages/integrations/src/helius/` from Chad's monorepo

**`packages/integrations/src/dexscreener/`** → stays inside Chad
- Actually, DexScreener is a generic market-data source used by multiple verticals; lift to `@ap3x/market-data` in `ap3x-platform/` and consume from there
- Chad's DexScreener client becomes an import: `import { DexScreenerClient } from "@ap3x/market-data"`

**`packages/integrations/src/jupiter/`** → consumed via `@ap3x/solana-connectivity` (Jupiter wrappers live there)
- Same pattern

**`packages/pump-gateway/`** → replaced by `@ap3x/pumpfun-protocol` + `@ap3x/pumpfun-signals`
- Chad's pump-gateway package gets deleted
- Chad's pumpfun widget mount calls platform signals directly
- `pump-gateway`'s README gets a deprecation note + migration guide

**`packages/chat-core/src/polymarket/`** → consumed via `@ap3x/polymarket-connectivity`
- Wait until PRP-10 lands first
- Then Chad's polymarket-specific integration deletes; widget consumes platform data

**`packages/chat-core/src/mcp/`** → Chad-specific, stays
- The MCP registry is Chad's specific concern (Moralis MCP, Exa MCP for research)
- Not a platform concern

**`packages/chat-core/src/graph/`** → Chad-specific, stays
- Chad's agent graph is Chad's domain logic
- But the LLM-research node could optionally consume `@ap3x/signals-*` for typed data access instead of MCPs — optional upgrade

### New Chad features enabled by the platform

**Strategy-aware chat:**
- When user says "buy me 0.3 SOL of this token," Chad doesn't roll its own buy logic — it submits to `@ap3x/strategy` SDK with a structured strategy
- Approval tiers are user-facing: Tier 2/3 actions pop a confirmation widget in the UI
- The chat UI becomes the first-class interface to the strategy runtime

**Live portfolio view:**
- Chad's sidebar shows live positions across pump.fun + Hyperliquid + Polymarket (via `@ap3x/portfolio`)
- "Close position" / "adjust stop" as chat commands

**Strategy creation from conversation:**
- User: "create a strategy that snipes any token from devs with reputation > 0.7 and sizes 0.5 SOL with 2x-5x-trailing exits"
- Chad generates a DSL strategy file, runs backtest, shows the result, asks for promotion approval
- Demonstrates the SDK + DSL in action

**Audit log surface:**
- Every trade Chad made is browsable in the chat history with full audit trail
- "Why did you buy that?" surfaces the `thesis` field + signal versions used

### Chad-specific things that stay

- Widget components (DexScreenerWidget, MoralisWidget, PolymarketWidget, PumpFunWidget, etc.) — these are Chad's UI domain
- Chat graph (widget-detect, fast-path-router, fetch-*, analyze, format, llm-research) — Chad's orchestration
- SSE streaming + widget event dispatch — Chad's wire format
- Thread management (from PRP-1 Phase 5)

### Chad-specific things that get upgraded

- Token/wallet analysis nodes — use `@ap3x/pumpfun-signals` + `@ap3x/solana-connectivity` for richer output
- Pump.fun widget — consumes `@ap3x/pumpfun-signals` directly instead of Chad's pump-gateway
- Polymarket widget — consumes `@ap3x/polymarket-connectivity` after PRP-10
- Research node — optionally gains typed access to `@ap3x/signals-*` data in addition to Exa MCP

## Out of scope

- **Production deployment** (DNS, hosting, scale testing) — Chad stays local-only until there's a reason to deploy
- **Multi-user auth** (still single-user)
- **Monetization / billing for Chad** — Chad is a demo, not a SaaS
- **Reverse — building platform features from Chad's needs** — platform is driven by the roadmap PRPs, not by Chad backlog items

## Deliverables

1. All Chad integration packages migrated per table above.
2. Chad runs against platform packages via cross-repo links (`pnpm workspace:*` or published packages if they are by then).
3. Three new Chad features shipped:
   - Strategy-aware chat (approve Tier 2/3 actions via UI)
   - Live portfolio view in sidebar
   - Strategy creation from conversation
4. Audit log visible in chat history + linkable by ID.
5. Old integration packages (`helius`, `jupiter`, `dexscreener`, `pump-gateway`) either deleted or deprecated with migration notes.
6. Updated Chad README + MIGRATION.md describing the rebuild.

## Acceptance criteria (gate)

1. **Feature parity with pre-rebuild Chad** — every query type that worked in Chad PRP-1 still works post-rebuild. Parity runner from Chad's PRP-1 validates.
2. **Platform usage validated** — Chad makes at least one call into every major `@ap3x/*` package during a representative session (`@ap3x/pumpfun-protocol`, `@ap3x/pumpfun-signals`, `@ap3x/solana-connectivity`, `@ap3x/polymarket-protocol`, `@ap3x/hyperliquid-*` if the user queries Hyperliquid data, `@ap3x/strategy`, `@ap3x/portfolio`, `@ap3x/policy`, `@ap3x/backtest`).
3. **New features demo-worthy** — strategy-creation-from-conversation: user types a description → Chad produces a working DSL strategy → backtest runs → result shown. Does it in one unbroken chat session.
4. **Old Chad packages gone or deprecated** — no dead code in Chad's monorepo.
5. **Operator can still run Chad locally** — `pnpm dev` works, backend boots on :8181, UI on :3000. Cross-repo platform links resolve transparently.

## Key design decisions

- **Chad is the consumer, not the platform contributor.** When Chad needs something, it either uses an existing platform primitive or it's Chad-specific and stays in Chad. Never "add feature to platform because Chad wants it." The platform is driven by the vertical + strategy + portfolio roadmaps, not by Chad.
- **Chad keeps its own repo.** Cleaner separation between showcase app and platform.
- **Chad's widgets stay Chad's.** Widget UIs are domain-specific UX; different consumer apps would have different widgets. The platform doesn't own UI.
- **Chad rebuild is the last PRP in the roadmap intentionally.** Chad's value depends on the platform being worth showcasing. Rebuilding earlier wastes work — Chad would just absorb incomplete abstractions.
- **Chad's agent graph stays.** Its composition of tools is Chad's domain. Agent graphs from other consumer apps would be different — a trading terminal would have very different nodes than a chat UI.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Cross-repo dev loop gets painful for Chad devs | Document setup; consider monorepo link tooling; smoke-test weekly |
| Platform packages not stable enough at PRP-09 time | Delay PRP-12 until post-GA; let PRP-10/10 exercise the platform more first |
| Chad's UI assumes too much about specific integrations | Widget components become the stable interface; integrations behind them swap |
| Feature parity regressions during migration | Parity runner from Chad's PRP-1 is already there; rerun at each migration step |
| Users attached to specific Chad inline behaviors | Behavior is preserved through migration; platform calls return semantically-equivalent data |

## What this PRP confirms

If a consumer app as specific as Chad can rebuild on the platform in 2-3 weeks, the platform's API is good enough to:
- Onboard external consumer apps
- Host third-party strategies without coupling to app-specific surfaces
- Support multiple showcase apps with different domain logic

This is the "the platform is acquirable" moment. An acquirer evaluates Chad + the platform stack together: "we're buying a Solana + Hyperliquid + Polymarket + NFT + (future: more) agent platform, and this is the chat UI reference implementation they built on it. We can replace Chad with our own consumer app in weeks."

## Next

After PRP-12: roadmap complete for the initial AP3X platform vision.

Future work streams:
- Additional verticals (PRP-11 template instances)
- Signal layer v2 (learned models replacing deterministic weighted rules)
- Platform npm publish (once API surface is stable across 3+ verticals + Chad)
- Control plane / ops automation (approval UI, deployment pipelines, multi-operator support)
- Open source strategy (which packages go public, which stay proprietary)
- Commercial model (free SDK + paid signals? platform SaaS? acquisition exit?)

Those are product + business decisions, not engineering PRPs.

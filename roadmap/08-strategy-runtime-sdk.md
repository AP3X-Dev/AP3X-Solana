# PRP-08 — Strategy runtime + SDK

**Repo:** `ap3x-platform/` (primary) + consumer repos (examples)
**Depends on:** PRP-07 (two verticals live with event stores + signals + backtest)
**Unblocks:** PRP-09 (portfolio layer), third-party strategy authorship
**Estimate:** 4 weeks solo
**Master spec:** [00-master-platform-prp.md §6.7, §7.5, §7.6](./00-master-platform-prp.md)

## Goal

Ship `@ap3x/strategy` — the **vertical-agnostic strategy runtime** that composes platform tool schemas from any vertical into a unified strategy-authoring surface. Two modes: **declarative DSL** (YAML/JSON compiled to rule-engine) and **agentic SDK** (TypeScript SDK wrapping tools, with LLM loop mediated by approval tiers). A strategy written against the SDK can target pump.fun, Hyperliquid, or Polymarket without changing the strategy code — only the tool-binding changes.

This is where the acquisition-target thesis becomes tangible: "deploy the same strategy format across any venue" is a pitch competitors can't match without doing the abstraction work we already did.

## In scope

### Package `@ap3x/strategy` (new, in `ap3x-platform/`)

**Runtime primitives:**

- `Strategy` base class — lifecycle methods (`onEvent`, `onSchedule`, `onPositionUpdate`, `onBalanceUpdate`), state management, tool call tracking
- `on_event(filter, handler)` — event-driven trigger
- `schedule(interval, handler)` — periodic trigger
- `position.manage(mint_or_coin, rules)` — hand off to rule engine
- Sandboxing — strategies are resource-bounded (CPU time, memory, tool calls per decision window)

**Declarative DSL (Mode A):**

- YAML/JSON strategy format per master PRP §7.5
- Schema-validated (zod) at load time
- Compiled to a rule-engine execution plan (deterministic, fast, microseconds per decision)
- Supports: `entry` conditions, `size`, `slippage_bps`, `priority_fee_tier`, `exits` (TP/trailing/hard_stop/time_stop), `risk` (caps), `min_signal_versions`
- Compiled plans are deterministic — same DSL + same signal versions → same decisions

**Agentic SDK (Mode B):**

- TypeScript SDK wrapping the tool schemas from each vertical
- LLM loop mediated by approval tiers from `@ap3x/policy`
- Strategy declares: event triggers, model ID (claude-opus-4-7 default), system prompt, tool budget per decision, time budget per decision
- Tool calls flow: agent → policy engine → simulation → receipt → submit (with full audit trail)
- Example strategies: `NarrativeMomentum` (pump.fun), `FundingPair` (Hyperliquid)

**Hybrid mode:**

- Declarative hot path (sub-second reactions on new mints / new fills)
- Agentic evaluation path (periodic position review, narrative assessment)
- Handoff via position manager

**Strategy registry:**

- Versioned strategy definitions (DSL string or SDK class export)
- Strategy lifecycle: `dev → backtest → paper → shadow → live`
- Promotion gates: backtest + paper + shadow all green before live promotion
- `@ap3x/strategy/registry` package — file-based + optional Postgres backend

**Shadow mode:**

- Live data, live decisions, no submission
- Outputs compared to a reference strategy
- Required gate before live capital > threshold
- Runs in parallel with live via same code path (decision recorded, `submit_tx` diverted to shadow-receipt-only)

### Vertical tool bindings

Each vertical publishes a strategy-facing tool surface via a new package per vertical:

- `@ap3x/pumpfun-strategy-tools` — wraps `@ap3x/pumpfun-policy` tool schemas as ergonomic SDK methods
- `@ap3x/hyperliquid-strategy-tools` — wraps `@ap3x/hyperliquid-policy` tool schemas
- Both expose a common interface from `@ap3x/strategy`'s perspective — they implement a `VerticalToolBinding` contract

### Cross-vertical strategy example

Ship `ap3x-platform/examples/cross-vertical-momentum/` — a strategy that:
- Opens pump.fun positions when dev-reputation score > 0.7 (vertical: pump.fun)
- Hedges via Hyperliquid SOL perps short when pump.fun exposure > 2 SOL (vertical: Hyperliquid)
- Same strategy file, two vertical tool bindings

This is the demo an acquirer runs to evaluate the platform.

## Out of scope

- **Capital allocator + cross-strategy risk** → PRP-09
- **Dashboards** → PRP-09
- **Multi-operator approval workflows for Tier 3** → PRP-09 (control plane)
- **Public SDK docs site / tutorials** → post-GA, product marketing
- **Non-Claude LLM providers** for agentic mode — v1 is Claude-only; multi-provider is a followup decision

## Deliverables

1. `@ap3x/strategy` package built in `ap3x-platform/`.
2. `@ap3x/pumpfun-strategy-tools` + `@ap3x/hyperliquid-strategy-tools` packages in their respective vertical repos.
3. DSL compiler with schema validation + deterministic compilation + backtest replay.
4. Agentic SDK with Claude Opus 4.7 integration, approval-tier-mediated tool calls, full audit trail.
5. Strategy registry with versioning + promotion pipeline (dev → backtest → paper → shadow → live).
6. Shadow mode operational for at least one strategy in each vertical.
7. Three strategies shipped:
   - `examples/pumpfun-snipe-declarative/` (DSL)
   - `examples/hyperliquid-funding-pair-agentic/` (SDK)
   - `examples/cross-vertical-momentum/` (hybrid, two verticals)
8. Documentation — `@ap3x/strategy/README.md` with DSL reference, SDK reference, quickstart, promotion guide.

## Acceptance criteria (gate)

1. **External-author paper trade** — a non-platform developer, given the SDK docs + 1h of onboarding, ships a new declarative strategy running in paper mode in < 60 minutes. Validated by 3 external-author trials.
2. **Cross-vertical strategy works** — `cross-vertical-momentum` runs in paper mode for 14 days, takes positions on both pump.fun and Hyperliquid, demonstrates the same strategy code surface across two verticals.
3. **DSL → execution determinism** — same DSL + same signal versions → bit-identical decision stream. Verified in CI.
4. **Agentic SDK audit completeness** — every tool call from the Opus 4.7 agent produces an audit log record with thesis, tier, signal versions, receipt, outcome. Zero missing records.
5. **Tier enforcement through SDK** — agent attempts to bypass tier → tool schema rejects. Cannot prompt-engineer around it.
6. **Shadow mode parity** — a strategy run in live + shadow produces identical decision streams for the same event stream; only `submit_tx` behavior differs.
7. **Promotion pipeline** — `strategy-cli promote <id> --from paper --to shadow` enforces backtest + paper gates; refuses if any gate failed.

## Key design decisions

- **Two modes, same tool schema.** DSL is a subset of what SDK can express; SDK is a subset of what an LLM can call directly. All three flow through the same policy engine.
- **Strategy code is vertical-agnostic; tool binding is vertical-specific.** Swapping `pumpfunTools` for `hyperliquidTools` in a strategy file changes the venue without changing the strategy logic.
- **Claude-only for v1.** Multi-provider support adds determinism concerns (different model outputs → different decisions on same event). Defer until we've proven the pattern on one provider.
- **Shadow mode shares the code path.** Same as paper shared the code path with live. Mode is an implementation detail of the tool binding.
- **Promotion is explicit.** No auto-promote from paper to live. Human approves each promotion after reviewing backtest PnL, paper divergence, and shadow agreement with reference strategy.
- **Strategy versioning is load-bearing.** DSL strategies are hashed; agentic strategies pin SDK version + model version. Backtests reproduce the exact decisions a prior strategy version made.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| DSL becomes Turing-tarpit as authors push its expressivity | Hard schema caps + "escape hatch: write it as an SDK strategy" |
| Agentic SDK hallucinates invalid tool calls | Tool schema validation rejects; audit log records the attempt |
| Model non-determinism blocks shadow-mode parity | Shadow mode for DSL strategies only initially; agentic shadow is advisory not gating |
| Third-party developers import malicious strategies into their wallet | Strategies run in sandbox; no filesystem or network access outside declared tool calls; operator review before live deploy |
| Cross-vertical strategies double-count risk budgets | Portfolio layer in PRP-09 handles cross-strategy risk aggregation; SDK v1 per-strategy budgets are separate |

## Post-PRP-08 landscape

At this point the platform looks like:

- Two live verticals with full event stores + signals (pump.fun, Hyperliquid)
- Cross-vertical strategy runtime with DSL + agentic SDK
- External authors can ship strategies without platform-internal knowledge
- Chad still runs as PRP-1 shipped — hasn't been rebuilt yet (that's PRP-12)

This is roughly "private beta" level. Individual strategy authors can use the platform. Multi-strategy operations + dashboards come in PRP-09; GA polish + signal expansion is PRP-09+.

## Next

On gate pass: PRP-09 (portfolio + lifecycle) unlocks.

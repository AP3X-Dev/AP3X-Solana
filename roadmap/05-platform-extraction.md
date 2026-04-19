# PRP-05 — Platform extraction

**Repo:** `ap3x-platform/` (NEW) + `ap3x-solana/` (refactor)
**Depends on:** PRP-04 (pump.fun vertical complete through signal layer)
**Unblocks:** PRP-06 (Hyperliquid foundation)
**Estimate:** 1-2 weeks solo
**Nature:** Refactoring. Zero new features. Comprehensive test coverage preservation.

## Goal

Extract the **vertical-agnostic substrate** from the pump.fun vertical into its own repo + packages. The contract: pump.fun still runs end-to-end after extraction with identical behavior. This PRP's value is architectural, not functional — it's what makes PRP-06 (Hyperliquid) a 3-week effort instead of a 12-week repeat.

## In scope

### New repo: `ap3x-platform/`

Create the platform monorepo with the same infra skeleton as `ap3x-solana/` (pnpm workspaces, Turbo, eslint-boundaries, Vitest, CI on Ubuntu + Windows).

### Packages to extract

Each extraction follows the pattern: **move the framework code, preserve the pump.fun-specific implementations where they belong, update imports, preserve tests.**

**`@ap3x/vertical`** — the interface contract every vertical implements
- TypeScript interfaces: `VerticalConnectivity`, `VerticalProtocol`, `VerticalSignals`, `VerticalExecution`, `VerticalFillModel`
- Shared types: `Receipt`, `SignalVersion`, `EventEnvelope`, `AsOfTimestamp`, `ConfidenceScore`
- Test utilities: `createTestVertical`, `verifyVerticalContract(impl)` — every vertical runs this in CI
- Source: pulled from pump.fun code where these types were first needed

**`@ap3x/policy`** — the cross-vertical policy engine
- Tool schema framework (generic; verticals provide their own tool definitions)
- Tier enforcement (Tier 0-3 logic, approval queuing, timeout handling)
- Risk cap primitives (rolling-window counter implementations, cross-wallet aggregators)
- Circuit breaker framework (pluggable condition checks, pause propagation)
- Kill switch with 5s SLA enforcement
- Audit log interface + SQLite + Parquet backends
- Source: extracted from `@ap3x/pumpfun-policy`; pump.fun-specific tool schemas stay in `@ap3x/pumpfun-policy` which now imports `@ap3x/policy` for the mechanism

**`@ap3x/signals-core`** — the event store framework + as-of query contract
- Event envelope structure, Parquet writer, DuckDB query shim
- Live-tap + historical backfill patterns (generic; vertical provides the event producer)
- Signal versioning + registry
- As-of query enforcement + lookahead fuzz utilities
- Precomputed signal cache pattern
- Source: extracted from `@ap3x/pumpfun-event-store`; pump.fun-specific signals stay in `@ap3x/pumpfun-signals` which now imports `@ap3x/signals-core` for the storage + query framework

**`@ap3x/backtest`** — the fill simulator framework
- Virtual clock
- Replay engine (generic; verticals provide their event iterator + fill model)
- Deterministic seed-controlled stochasticity
- Attribution framework (by-signal, by-hour, by-bucket)
- Paper mode adapter (shared code path with live)
- Shadow mode adapter
- Source: extracted from `@ap3x/pumpfun-backtest`; pump.fun's curve-specific fill model stays in `@ap3x/pumpfun-backtest` which now implements the `VerticalFillModel` interface from `@ap3x/vertical`

**`@ap3x/vault`** (small, lifted from `@ap3x/solana-connectivity`)
- Encrypted keypair storage (libsodium secretbox + Argon2id)
- Named roles + per-role caps
- Pluggable backends (file, KMS, HSM stubs)
- Source: extracted from `@ap3x/solana-connectivity`; Solana-specific wallet signing stays; the vault primitive is cross-vertical (Hyperliquid needs keys too)

### Post-extraction state of `ap3x-solana/`

Every pump.fun vertical package imports its respective platform package:

- `@ap3x/pumpfun-policy` → imports `@ap3x/policy`, implements pump.fun tool schemas
- `@ap3x/pumpfun-event-store` → imports `@ap3x/signals-core`, provides pump.fun event producer
- `@ap3x/pumpfun-signals` → imports `@ap3x/signals-core`, defines pump.fun-specific signals
- `@ap3x/pumpfun-backtest` → imports `@ap3x/backtest`, provides pump.fun fill model
- `@ap3x/solana-connectivity` → imports `@ap3x/vault`, Solana-specific wallet logic on top

Every pump.fun package declares `@ap3x/vertical` contract conformance via `verifyVerticalContract(impl)` in its test suite. CI fails if a vertical package breaks the contract.

## Out of scope

- **Any functional change.** Behavior is bit-identical pre- and post-extraction. Verified via the PRP-03 hardcoded strategy's backtest: same inputs, same outputs.
- **Publishing to npm.** All platform packages stay workspace-only through PRP-07. Chad and pump.fun link to them via `pnpm` workspace refs across repos (`file:../ap3x-platform/packages/...`).
- **Second vertical starts.** PRP-06 (Hyperliquid) begins after this PRP, not concurrently.
- **New abstractions.** This PRP only extracts what pump.fun's Phase 0/1/2 forced to exist. Nothing speculative.

## Deliverables

1. `ap3x-platform/` monorepo created, populated with 5 packages above.
2. `ap3x-solana/` refactored to consume platform packages.
3. Every pump.fun package has a contract conformance test in CI.
4. PRP-03 hardcoded strategy still runs (live or paper) with identical behavior post-extraction.
5. Cross-repo workspace link working for dev loop (pnpm `link:` protocol or equivalent).
6. Documentation — `ap3x-platform/README.md` explaining the vertical contract + how to add a new vertical; updated `ap3x-solana/README.md` noting it's now a platform consumer.

## Acceptance criteria (gate)

1. **Behavioral parity** — PRP-03's hardcoded strategy running on PRP-04's event store produces bit-identical backtest output pre- and post-extraction. Verified by regression test.
2. **Test preservation** — every test from PRP-01/02/03/04 still passes. No test skipped, no coverage dropped.
3. **Contract conformance** — every pump.fun package's `verifyVerticalContract(impl)` test passes in CI.
4. **No circular deps** — `eslint-boundaries` in both repos green. Platform packages don't know about verticals; verticals import platform.
5. **Cross-repo dev loop works** — a change in `ap3x-platform/packages/@ap3x/policy` is picked up by `ap3x-solana/` without manual rebuild, confirmed via smoke test.
6. **Platform package API freeze** — package.json `0.1.0` release tag across all platform packages; semver contract documented.

## Key design decisions

- **Extract what's forced, not what's imagined.** If pump.fun's Phase 0/1/2 didn't force a primitive to exist, it doesn't extract. PRP-06 will force more extractions when Hyperliquid's needs surface.
- **Contract first, implementation second.** `@ap3x/vertical` defines the interface; vertical packages implement it. Platform packages don't depend on vertical packages.
- **Conformance tests are mandatory.** Every vertical implementation package runs `verifyVerticalContract(impl)`. If a vertical can't satisfy the contract, either the contract is wrong or the vertical is. Either way, the gap is visible.
- **Zero-functional-change discipline.** Refactor PRs have no behavior changes. This is the hardest discipline in engineering and non-negotiable here: the whole point is to preserve pump.fun while enabling Hyperliquid.
- **Platform packages stay workspace-only.** Publishing is premature until Hyperliquid (PRP-06/06) validates the abstractions. Publishing would lock APIs before they've been tested against the second vertical.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Extraction reveals "pump.fun-specific" hiding in the abstractions | This is the POINT. Refactor until clean. If a clean extraction isn't possible, the abstraction isn't ready. Ship only what's cleanly extractable. |
| Cross-repo dev loop friction slows iteration | pnpm `workspace:*` + cross-repo `link:` protocol; document setup in CONTRIBUTING; smoke-test weekly |
| Test coverage drops during refactor | CI fails on coverage drop. Hard gate. |
| Breaking change in refactor lands silently | Regression test (the PRP-03 strategy backtest producing bit-identical output) is the canary |
| Platform package version drift between workspace-link and eventual npm publish | Document that platform packages are unpublished pre-PRP-07; first publish is coordinated with Hyperliquid GA |

## What we DON'T extract

To avoid over-abstraction, these stay vertical-specific:

- **Priority fee estimation** — Solana-specific. Hyperliquid has completely different fee mechanics (maker/taker rebates). No cross-vertical abstraction value.
- **Jito bundle submission** — Solana-specific. Has no analog in Hyperliquid.
- **Bonding curve math** — pump.fun-specific. Other verticals have different pricing mechanisms.
- **ATA management** — Solana-specific concept.
- **Geyser subscription patterns** — Solana-specific streaming API.

If Polymarket (PRP-10) or a future vertical reveals shared patterns in these, we extract then. Not speculatively.

## Next

On gate pass: PRP-06 (Hyperliquid Phase 0) unlocks. This is the crucial validation — can the platform actually host a second vertical with a 3-week effort?

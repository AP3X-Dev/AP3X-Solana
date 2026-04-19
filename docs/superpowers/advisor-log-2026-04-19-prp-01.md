# Advisor Decision Log — PRP-01 Solana substrate

Autonomous run: `autonomous-prp-01-2026-04-19`
PRP: `roadmap/01-solana-substrate.md`
Mode: Option A (prep environment, run autonomously, defer live-mainnet acceptance gates)

## Decision 1: DESIGN_APPROVAL — full spec
**Skill:** brainstorming (combined design + spec self-review checkpoint)
**Question:** Approve the design spec at `docs/superpowers/specs/2026-04-19-prp-01-solana-substrate-design.md`?
**Advisor decided:** APPROVE
**Reasoning:** Spec covers all 7 packages + example app + all 8 acceptance gates (gates 1/3/5 marked deferred per Option A). Zero-deps, v0-tx-only, vault crypto, instance-based decoder registry, and Geyser semantics all match PRP + AMP priors. Boundary-rule narrowing (Section 2) is consistent with Section 3.4. Section 9 design decisions are reasonable, reversible, and honor PRP posture; no scope creep.
**Action:** Proceed to writing-plans. Plan must (a) sequence per Section 10 (core → connectivity/vault → tx → spl/metaplex → events → examples), (b) front-load fixture capture, (c) resolve the two hedges (Geyser priority-fee subscription shape + `bin` placement for `pnpm diag`) as concrete plan steps, (d) tag deferred gate-1/3/5 verifications as backlog items gated on Helius credentials.

## Decision 2: SELECTION — execution approach
**Skill:** writing-plans
**Question:** Subagent-driven vs. inline execution for the 35-task plan?
**Advisor decided (rule-based, no dispatch needed):** Subagent-driven. Per autonomous-advisor SELECTION rule, execution approach is always subagent-driven (better quality, fresher context per task).
**Action:** Set up worktree at `.worktrees/prp-01-solana-substrate`, create branch `prp-01-solana-substrate`, invoke `superpowers:subagent-driven-development`, dispatch implementer per task.

## Backlog (deferred to optimization loop, gated on Helius/Triton/QuickNode credentials)

- **B1 (gate 1):** Run `examples/solana-watch/scripts/acceptance.sh` 1h vs live mainnet, verify p50<500ms p99<2s.
- **B2 (gate 2):** Run `pnpm capture:spl` + `pnpm capture:metaplex`, then run regression suites against 500+ captured accounts.
- **B3 (gate 3):** Live Geyser 10-slot gap recovery test, verify recovery via RPC backfill within 5 slots.
- **B4 (gate 5):** Priority-fee p99 ± 10% vs observed landed fees on 10 sample slots.
- **B5 (T14):** Live Yellowstone endpoint test for `GeyserClient` — open a real subscription against Helius/Triton, observe ≥10 minutes of slot/account updates, confirm zero dropped events under nominal load, and validate checkpoint resume across a process restart. Gated on credentials. Synthetic proto + in-process gRPC loopback coverage shipped in T14 as a stand-in; B5 is the live counterpart.
- **B6 (gate 2, SPL):** Run `RPC_URL=... pnpm capture:spl` to generate `tests/fixtures/spl-accounts.json.gz` (500 mints + 500 token accounts). Then add a regression test under `packages/solana-spl/` that iterates every captured account, runs `decodeMint` / `decodeTokenAccount`, and asserts structural invariants (e.g. decimals ≤ 9 for real-world mints, `state` is a valid enum variant, supply parses as `bigint`). This ungates gate-2 for SPL. Depends on a provider that accepts the `dataSize` filter on `getProgramAccounts` — Helius + Triton support it; shared public endpoints generally do not.
- **B7 (gate 2, Metaplex):** Run `RPC_URL=... pnpm capture:metaplex` to generate `tests/fixtures/metaplex-accounts.json.gz` (200 metadata accounts across v1 / v1.3 / current layouts). Then add a regression test under `packages/solana-metaplex/` that decodes each captured account via `decodeMetadata` and asserts the version/field invariants listed in the spec (stripped-NUL name/symbol/uri, `sellerFeeBasisPoints <= 10000`, `creators` share percentages sum to 100 when present). Depends on a provider that accepts `getProgramAccounts` on `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` with `memcmp` + `dataSize` filters — typically requires a paid tier.

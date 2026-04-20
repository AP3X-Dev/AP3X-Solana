# Advisor Decision Log — PRP-02.5 pump.fun protocol

Autonomous run: `autonomous-prp-02.5-2026-04-20`
PRP: `roadmap/02.5-pumpfun-protocol.md`
Mode: Same autonomous pipeline as PRP-02 — brainstorming → spec → plan → worktree → subagent-driven dev → finishing-a-development-branch → optimization loop. Advisor sub-agent at every human checkpoint; `commit no push` local-merge preference preserved from the project's prior runs (no remote configured).

## Decision 1: DESIGN_APPROVAL — full design spec

**Skill:** brainstorming (spec review checkpoint)
**Question:** Approve the design spec at `docs/superpowers/specs/2026-04-20-prp-02.5-pumpfun-protocol-design.md`?
**Advisor decided:** APPROVE_WITH_NOTES
**Reasoning:** The spec satisfies every PRP §Deliverables item and maps each of the 9 acceptance gates to concrete test tasks. Out-of-scope boundaries are honored — write-path safety → PRP-03, authority/vanity/launch → PRP-03.5, off-chain HTTP APIs and event store → PRP-04. Conventions from PRP-01/02 preserved: zero ecosystem deps (forbidden-deps CI gate inherited), v0 txs via `@ap3x/solana-tx`, decoder framework with typed `UnknownEventDecode`, stateless protocol package (no lifecycle), real captured fixtures over mocks, ESLint boundaries forbid pump.fun → runtime imports. Two-package design (compat dropped → PRP-04 signal source), instruction-builder inclusion (moved up from PRP-03), full program coverage (bonding curve + PumpSwap), layered fixtures, and stateless `fetchRecentTrades` all match the PRP and the brainstorming outcomes.

**Notes addressed inline before plan-writing (spec edits):**
1. **Phase count corrected.** §11 header said "5 phases" but enumerated A-F = 6. Corrected to "6 phases."
2. **PumpSwap Anchor-discriminator verification made an explicit Phase A checkpoint.** PumpSwap event-signaling convention is unverified (§10 risk). Phase A now requires a live-sample decode before committing to the decoder implementation, so drift from the Anchor pattern surfaces early.
3. **BP4 (fixture refresh runbook) promoted from backlog to Phase F.** Pairs with the nightly diag gate; closes the loop on program-upgrade drift.
4. **Devnet vs mainnet-fork for roundtrip acceptance gate (BP2) now an explicit Phase C start-of-phase checkpoint** rather than mid-phase decision.
5. **`buildCreate` initial-buy exclusion documented in Phase F's `docs/architecture/pumpfun.md`** — consumers wanting atomic create+snipe compose `buildCreate` + `buildBuy` at the caller; formal launch-and-snipe orchestrator ships in PRP-03.5.

**Notes for the implementer (non-blocking; carry into the plan):**
1. `priceFromReserves` formula in §4.3 is intentionally a placeholder — Phase B curve-math task must not be marked complete until the formula is locked and the ≥100-trade regression passes.

**Action:** Proceed to `superpowers:writing-plans`. Plan must (a) sequence per Phases A-F in §11, (b) preserve the Phase A / Phase C / Phase F checkpoints called out above, (c) honor the advisor's implementer note re `priceFromReserves`, (d) identify parallelizable tasks per phase for subagent dispatch (B + C can run in parallel after A lands; E depends on A-D complete).

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

## Decision 2: PLAN_APPROVAL — implementation plan

**Skill:** writing-plans (plan review checkpoint)
**Question:** Approve the implementation plan at `docs/superpowers/plans/2026-04-20-prp-02.5-pumpfun-protocol.md`?
**Advisor decided:** APPROVE_WITH_NOTES
**Reasoning:** All six DESIGN_APPROVAL notes carried forward correctly and mapped to specific task steps. All 7 PRP deliverables and 9 acceptance gates covered. 22-task structure honors the spec §11 "18-24 tasks / 6 phases" budget and mirrors PRP-02's TDD granularity, parallelization callouts (B+C after A, E after A-D, F after E/17), and Helius-free-tier self-skip pattern. Package boundaries in Tasks 1 and 7 match spec §2.2 (with one adjustment — see note 8 below) and correctly forbid pump.fun → runtime imports. Several code blocks contained intentionally-broken placeholders the implementer would have had to rewrite — fixed inline before proceeding.

**Notes addressed inline before implementation (plan edits):**
1. **Task 13 CommonJS `require()` in ESM package removed.** Replaced with top-of-file `import { findProgramAddress } from '@ap3x/solana-tx'`. Also replaced `PublicKey.fromBase58('mintAuthorityPlaceholder')` (not valid base58 — would have thrown) with a real `deriveMintAuthorityPda()` helper using `findProgramAddress([enc('mint-authority')], PUMPFUN_BONDING_CURVE_PROGRAM_ID)`. Seed still requires captured-tx confirmation during implementation but at least compiles.
2. **Task 6 silent-pass on missing variant fixtures fixed.** Switched from `console.warn + return` (which left the `it` green) to `skip(reason)` via vitest's test-context skip API. PRP gate 2 ("one unit test per variant") is now honored — missing variants show up as skipped tests, not false greens.
3. **Task 11 `fetch-recent-trades.ts` program-ID string placeholders replaced.** `'PUMPFUN_BONDING_CURVE_PROGRAM_ID_BASE58'` literal strings → real imports of `PUMPFUN_BONDING_CURVE_PROGRAM_ID` + `.toBase58()` computed once at module scope.
4. **Task 16 routing.buy + routing.sell post-graduation branches fixed.** Was shipping `inputMint: mint, outputMint: mint` (same mint both sides — impossible for a swap) + `throw new Error('not implemented')` for the sell branch. Now imports `WSOL_MINT`, fetches `pumpSwapPoolState`, computes `expectedTokensOut` / `expectedSolOut` via AMM math, derives a reasonable `minOutputAmount` with 1% slippage headroom. Both buy and sell branches now work symmetrically across the graduation boundary.
5. **Task 11 "one test" for gate 4 upgraded to "10 live mints each" for `curveState` AND `pumpSwapPoolState`** — matches PRP gate 4's requirement explicitly. Previously underspecified; could have led to partial gate-4 coverage.
6. **Spec §2.2 allowed-imports for `pumpfun-events` updated** to include `'tx'` — the PDA helper `findProgramAddress` lives in `@ap3x/solana-tx` and is needed for the decoder's event-authority PDA derivation. Prior spec version said `['core', 'events']` only. Confirmed with the implementation constraint; spec now matches the plan's allow-list.

**Notes for the implementer (non-blocking; carry into implementation):**
1. **Task 5 `pumpfun.admin_*` variant flattening.** Spec §4.1 implies each admin variant gets its own `.kind` suffix. Plan currently hardcodes a single `pumpfun.admin_set_params`. If T5 fixture capture surfaces additional admin variants, extend the union and add dispatch paths — don't cram them all into one `kind`. Any unmatched admin discriminator should fall through to `UnknownEventDecode` per spec §6.
2. **Task 2 encoder/decoder symmetry.** Plan's `encodeString` (u32 LE length prefix) matches `readString` / `readVecU8` (u32 LE length). Roundtrip tests should verify this — if the bonding curve program uses a different string encoding convention (some Anchor programs use u16 for short strings), surface it during T3's real-fixture decoding.
3. **`deriveMintAuthorityPda` seed is unverified.** The placeholder `[b"mint-authority"]` is a best-effort based on typical Anchor patterns. Confirm against a captured mainnet Create tx during T13 implementation. If the seed differs, update the helper and rerun the roundtrip test.

**Action:** Proceed to `superpowers:using-git-worktrees` → create `.worktrees/prp-02.5-pumpfun-protocol`. Then `superpowers:subagent-driven-development` with fresh implementer subagent per task + spec-compliance review + code-quality review per checkpoint. Sequence per Phases A-F in plan.

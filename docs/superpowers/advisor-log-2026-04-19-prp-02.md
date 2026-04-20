# Advisor Decision Log — PRP-02 Solana runtime

Autonomous run: `autonomous-prp-02-2026-04-19`
PRP: `roadmap/02-solana-runtime.md` (supersedes the prior `02-pumpfun-protocol.md`; pump.fun re-sequenced to PRP-03)
Mode: Same as PRP-01 — autonomous through brainstorming → spec → plan → worktree → subagent-driven dev → finishing-a-development-branch. Live-mainnet gates deferred to backlog (Helius free tier — Business required for live Geyser/Jito).

## Decision 1: DESIGN_APPROVAL — full spec

**Skill:** brainstorming (combined design + spec self-review checkpoint, advisor-played user-review gate)
**Question:** Approve the design spec at `docs/superpowers/specs/2026-04-19-prp-02-solana-runtime-design.md`?
**Advisor decided:** APPROVE_WITH_NOTES
**Reasoning:** Spec delivers all 4 packages (signals, strategy, executor, portfolio) + spl-watcher example, maps every one of the 13 acceptance gates in §5, and preserves the three locked-in design decisions intact (8-hook class API w/ per-instance state and serialization; on-chain cost-basis reconstruction w/ per-lot Lot[] + FIFO/LIFO/avg-cost + extension-safe SwapTracer; both Jito submitters w/ vendored proto + Submitter seam). Boundary layering is coherent — the `runtime.adaptToLandedTrades` adapter in `StrategyRuntime` + portfolio's executor-agnostic `LandedTrade` shape genuinely breaks the executor↔portfolio cycle, and the proposed `eslint-boundaries` additions enforce it. Inheritance from PRP-01 conventions (atomic tmp+rename, per-key mutex, file-backed defaults, AbortSignal honored throughout, structured `Ap3xError` codes, instance-based registries, vendored-proto pattern with pinned commit) is faithful.

**Notes addressed inline before plan-writing:**
1. **Gate-8 fixture provenance corrected.** Advisor flagged a perceived contradiction (claimed `spl-accounts.json.gz` was still backlog/gated). In fact PRP-01 commits `80eb783` (capture) and `3aa221f` (regression test close-out) shipped the fixture; the user kickoff prompt confirmed it. §5 row 8 updated to reflect: (a) shipped status w/ commit refs; (b) the additional `cold-start-tx-history.jsonl.gz` fixture needed for cost-basis reconstruction is captured as a Phase-A prereq (Helius free tier supports `getSignaturesForAddress` + `getTransaction`, so this is API-key-gated, not Business-gated).
2. **Cold-start tx-history fixture added to §2.1 deliverables.** Plan will include a `pnpm capture:cold-start-tx-history` task companion to existing `capture:spl` / `capture:metaplex`.
3. **Per-instance hook serialization documented as deliberate widening.** PRP §66 mandates serialization only for signals; spec extends to all hooks for race elimination + gate-6 backtest determinism. Already explicit in §3.2; advisor confirmed this is sound.
4. **Strategy `onError` synchronous semantics added to §9 plan handoff** — `runtime-architecture.md` will document so strategy authors don't `await` work inside it.
5. **Bundle `ConfigError` wording polished in §3.3 step 8** — fires synchronously at submit time when `bundleGroup` is set without a Jito submitter configured, not at submitter registration.

**Action:** Proceed to `superpowers:writing-plans`. Plan must (a) sequence per Phases A–E in §9, (b) front-load the cold-start tx-history fixture capture as a Phase-A task, (c) produce the new `pnpm capture:cold-start-tx-history` script, (d) tag B8/B9/B10/B11 deferred gates as backlog items joining PRP-01's B1/B3/B4/B5, (e) identify parallelizable tasks per phase for subagent dispatch.

## Decision 2: PLAN_APPROVAL — implementation plan

**Skill:** writing-plans (advisor-played user-review gate)
**Question:** Approve the implementation plan at `docs/superpowers/plans/2026-04-19-prp-02-solana-runtime.md`?
**Advisor decided:** APPROVE_WITH_NOTES
**Reasoning:** Plan delivers 50 tasks across 5 phases (A: signals + SPL decoders + fixture; B: portfolio; C: executor; D: strategy; E: example; F: wrap-up) with TDD discipline mirroring PRP-01 (write-test → fail → implement → commit per task). Every spec section maps to one or more tasks (verified via plan's self-review §map). All 13 acceptance gates mapped to concrete test tasks. Phase ordering respects boundary layering (signals/portfolio/executor mutually independent; strategy depends on all three). Backlog (B8–B11 plus a thoughtful new B12 — gate-8 fixture fallback if no Helius free-tier API key at execution time) ties each item to a specific gate with credentialing context. Parallelizable tasks explicitly identified for subagent dispatch (B/C parallel after A; sources within signals; submitters within executor).

**Notes for the implementer (non-blocking; resolve during execution):**
1. **Task 32 ConfigError hoist.** Plan currently routes the bundle/no-Jito-submitter validation through `this.rejected(...)` inside `inFlight.run`. Spec §3.3 step 8 says "rejects synchronously... before queuing." Implementer should hoist the validation above `inFlight.run` so the rejection truly fires synchronously at the API boundary; then choose to throw a typed `ConfigError` (spec wording) OR surface as `ExecutionResult{ kind: 'rejected' }` (executor's uniform error envelope) — either is defensible; pick one and document.
2. **Task 32 vault API mismatch.** Plan calls `vault.unlock(intent.wallet, '')` with empty passphrase; comment notes "passphrase resolution out-of-scope; assumes pre-unlocked." Reconcile against the actual `Vault` API shipped in PRP-01 — likely `vault.getHandle(name)` for an already-unlocked wallet, with `WalletLocked` surfacing on lock state.
3. **Task 43 `runBacktest` placeholder.** The body is intentionally illustrative ("expand using StrategyRuntime from Task 42 with substituted executor + portfolio"). Implementer subagent should flesh out fully — no stubs in the final commit; gate-6 backtest determinism depends on it.
4. **Task 42 hook-serialization comment.** `dispatchSignal` enqueues `executor.submit` through the per-instance queue, which serializes that submit alongside hooks (load-bearing for gate-6 determinism). Worth a comment in `runtime-architecture.md` (Task 49) so the design intent is preserved.
5. **Task 47 CLI scaffolding.** `index.ts` is partially scaffolded (~50 LOC of source-selection + wiring left to fill in). Implementer to complete.

**Action:** Proceed to `superpowers:using-git-worktrees` → create `.worktrees/prp-02-solana-runtime`. Then `superpowers:subagent-driven-development` with fresh implementer subagent per task + spec-compliance review + code-quality review per checkpoint. Sequence per Phases A–E in plan §9 / spec §9.

## Backlog (deferred to optimization loop, gated on Helius Business / Jito mainnet credentials)

Joins PRP-01 backlog (B1/B3/B4/B5/B6/B7 — most resolved during PRP-01 close-out except B1, B3, B4, B5 which remain credential-gated).

- **B8 (gate 1, live):** Run `examples/spl-watcher` against live Geyser for 1h, assert zero lost signals + p99 ingest-to-strategy latency < 2s. Gated on Helius Business ($499/mo) for mainnet Geyser/LaserStream.
- **B9 (gate 9, live):** Submit a real Jito bundle via `JitoGrpcSubmitter` against Jito mainnet block engine; assert landing slot + tip-account assignment match. Gated on Jito searcher credentials.
- **B10 (gate 7, live):** External transfer into a tracked wallet on devnet; assert reconciler detects + re-reconstructs within 60s. Devnet-OK; can run with current free-tier Helius once devnet streaming is wired.
- **B11 (gate 8, live, expanded coverage):** Capture additional cost-basis fixtures from 50 mainnet wallets via paid Helius (free tier covers the 10 wallets used in CI gate-8). Optional expansion — only if gate-8 surfaces edge cases the 10-wallet set misses.
- **B12 (gate 8, fixture fallback):** If Task 3's `pnpm capture:cold-start-tx-history` was skipped at run time (no Helius free-tier API key available), the gate-8 test self-skips. Run the script later (one-time, free tier sufficient) and commit the resulting `tests/fixtures/cold-start-tx-history.jsonl.gz` to close gate 8 in CI. Lower-cost than B11.

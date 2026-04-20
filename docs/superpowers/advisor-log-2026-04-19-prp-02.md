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

## Backlog (deferred to optimization loop, gated on Helius Business / Jito mainnet credentials)

Joins PRP-01 backlog (B1/B3/B4/B5/B6/B7 — most resolved during PRP-01 close-out except B1, B3, B4, B5 which remain credential-gated).

- **B8 (gate 1, live):** Run `examples/spl-watcher` against live Geyser for 1h, assert zero lost signals + p99 ingest-to-strategy latency < 2s. Gated on Helius Business ($499/mo) for mainnet Geyser/LaserStream.
- **B9 (gate 9, live):** Submit a real Jito bundle via `JitoGrpcSubmitter` against Jito mainnet block engine; assert landing slot + tip-account assignment match. Gated on Jito searcher credentials.
- **B10 (gate 7, live):** External transfer into a tracked wallet on devnet; assert reconciler detects + re-reconstructs within 60s. Devnet-OK; can run with current free-tier Helius once devnet streaming is wired.
- **B11 (gate 8, live, expanded coverage):** Capture additional cost-basis fixtures from 50 mainnet wallets via paid Helius (free tier covers the 10 wallets used in CI gate-8). Optional expansion — only if gate-8 surfaces edge cases the 10-wallet set misses.

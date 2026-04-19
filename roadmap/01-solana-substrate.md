# PRP-01 — Solana substrate

**Repo:** `ap3x-solana/` (new monorepo — houses both Solana substrate and Solana-venue verticals)
**Depends on:** `@ap3x/core` (published, stable)
**Unblocks:** PRP-02 (pump.fun protocol), any other Solana-venue vertical (Raydium, Orca, Meteora, Magic Eden, Jito) at any future time
**Estimate:** 2-3 weeks solo

## Goal

Ship `@ap3x/solana-*` — a **generic Solana agent toolkit** that any Solana-venue vertical consumes. Pure Solana primitives with no venue-specific coupling: RPC pool, Geyser stream, v0 transaction builder, priority-fee estimator, SPL + Metaplex account parsers, generic event decoder framework, encrypted keypair storage. An external Solana agent project could `pnpm add @ap3x/solana-*` and build on it without ever touching pump.fun.

This PRP establishes **`@ap3x/solana` as a publishable asset on its own** — independent of any specific venue. Pump.fun (PRP-02) is the first consumer that validates the abstractions; Raydium / Orca / Magic Eden / Jito can arrive later and skip this foundation entirely.

## In scope

### Package `@ap3x/solana-core`

- **Base58 encode/decode** — hand-rolled, no external deps
- **`PublicKey`** — 32-byte buffer + string form, equality + base58 conversion; read-only (PDA derivation lives in `@ap3x/solana-tx` alongside write-path primitives)
- **`Cluster`** enum + RPC URL mapping (mainnet, devnet, testnet, custom)
- **Compact-u16 + Borsh-lite** — minimal binary-layout primitives used by every parser
- **Common error types** — `RpcError`, `DecodingError`, `TimeoutError` etc. shared across the substrate packages
- **Shared HTTP client** — thin wrapper over the pattern established in Chad's PRP-1 (`HttpClient` with retry/timeout/circuit-breaker) — lifted + relicensed

### Package `@ap3x/solana-connectivity`

- **RPC pool** — primary + two fallbacks (Helius, Triton, QuickNode supported). Latency-scored with automatic failover. Every call emits metrics (`latencyMs`, `errorClass`, `retryCount`). Read path round-robins; write path pins to lowest-latency healthy node per tx.
- **Yellowstone gRPC Geyser client** — subscribes to arbitrary program IDs for logs + account updates. Backpressure (drop-oldest-with-alarm), gap detection on slot skips, gap replay via RPC historical. Local stream checkpoint persisted so a restart doesn't miss events.
- **RPC historical backfill** — typed wrappers for `getSignaturesForAddress` + `getTransaction` with pagination; utility for "fetch events for program X between slots A-B" that the signal layer backfill jobs use.
- **Health + diagnostic probes** — CLI + library tooling that matches Chad's `pnpm diag` pattern for monitoring RPC provider drift.

### Package `@ap3x/solana-tx`

- **Versioned (v0) transaction builder exclusively** — no legacy tx support.
- **PDA derivation** — `findProgramAddressSync` equivalent, hand-rolled using `@noble/ed25519` for off-curve checks (allowed exception to zero-dep posture for audited crypto primitives).
- **ALT support** — build + read Address Lookup Tables; platform-managed ALTs are a vertical's concern (pump.fun's ALT lives in `@ap3x/pumpfun-*`).
- **Compute unit limit** from simulation + 15% buffer; never unbounded. Simulation hookup stubbed in PRP-01; full sim wiring in PRP-03.
- **Priority fee estimator** — rolling-window percentile of landed fees from Geyser. Tiers: `low=p50`, `med=p75`, `high=p90`, `turbo=p99 + dynamic topup`. Strategies pick a tier, never lamports. Recomputed every slot.
- **Jito bundle builder** — composes up to 5 txs atomically. Tip helper functions. **Dispatcher** (actual live bundle submission) stays for PRP-03 when policy gating exists.
- **Transaction assembler** — takes `{ instructions, payer, signers, recentBlockhash }` → serialized v0 transaction. Stops at "ready to sign + submit"; signing is a wallet concern.

### Package `@ap3x/solana-spl`

- **Mint account parser** — `TokenMint` typed record: decimals, supply, mint authority, freeze authority, is_initialized
- **Token account parser** — `TokenAccount` typed record: owner, mint, amount, delegate, state
- **Token 2022 detection** — program-id check + token-2022 account layout parser (differs from SPL v1 in several fields)
- **ATA derivation** — `getAssociatedTokenAddress(mint, owner)` + `createAssociatedTokenAccountIx(payer, owner, mint)` instruction builder
- **Holder queries** — `getTokenLargestAccounts(mint)` + `getTokenAccountsByMint(mint)` wrappers returning typed results

### Package `@ap3x/solana-metaplex`

- **Metadata PDA derivation** — from mint → metadata account address
- **Metadata account parser** — Borsh decoder for the Metaplex Token Metadata program's metadata account format; handles v1 + v1.3 + current formats
- **URI + off-chain resolver** — fetches the metadata URI, parses off-chain JSON with shape tolerance, caches results (LRU + file-backed optional)
- **Collection + delegate helpers** — read-only utilities for collection parent/child relationships
- **Compressed NFT support** — stubbed interface; full cNFT (state-compression) support deferred to Magic Eden vertical's PRP

### Package `@ap3x/solana-events`

- **Generic event decoder framework** — vertical-specific decoders plug in via `registerDecoder(programId, decoder)` + `decode(logs) → EventUnion | UnknownEventDecode`
- **Program log parser** — handles `Program log:` / `Program data:` / invoke-chain boundaries per Solana program log conventions
- **CPI decoder** — cross-program-invocation log normalization for accurate nested event attribution
- **Exhaustive match enforcement** — decoders emit typed event unions; unknown variants surface as structured `UnknownEventDecode` records in a separate channel — never silently dropped

### Package `@ap3x/solana-vault`

- **Encrypted keypair storage** — libsodium `secretbox` with passphrase-derived key (Argon2id). Named wallets with role metadata + per-role caps. Storage backend pluggable (file-based default; KMS/HSM adapter slots for later).
- **`WalletHandle`** — opaque, never returns raw keypair. Supports `sign(message)`, `signTransaction(tx)`, `address: PublicKey`.
- **SOL balance guard** — reserves N SOL per wallet for rent + fees; spend attempts that would dip into reserve fail at the wallet API layer.
- **Key rotation + audit** — rotation utility + append-only audit log of unlock events.

Note: named `@ap3x/solana-vault` for clarity, not `@ap3x/vault`. The cross-chain `@ap3x/vault` extraction happens in PRP-05 when Hyperliquid's EIP-712 signing forces a chain-agnostic abstraction.

### Example app `examples/solana-watch/`

- ~100-line Node script that uses the substrate packages to:
  - Subscribe to an arbitrary program ID via Geyser
  - Decode SPL + Metaplex + generic program events to typed records
  - Print typed stream to stdout with latency measurement
- This is PRP-01's dogfooding surface. Zero pump.fun-specific code.

## Out of scope

- **Pump.fun decoders + curve math + typed client** → PRP-02
- **Write-path execution, simulation, receipts, Jito bundle dispatcher** → PRP-03
- **Policy engine, tiers, circuit breakers** → PRP-03
- **Event store + signals** → PRP-04
- **Any venue-specific protocol wrappers** (Raydium, Orca, Meteora, Magic Eden, etc.) → separate vertical PRPs if pursued

## Deliverables

1. Monorepo scaffold at `ap3x-solana/` — pnpm workspaces + Turbo + eslint-boundaries, CI on Ubuntu + Windows, Vitest + msw for tests.
2. Seven packages workspace-published: `@ap3x/solana-core`, `-connectivity`, `-tx`, `-spl`, `-metaplex`, `-events`, `-vault`.
3. Example app `examples/solana-watch/` running continuously for 1 hour against live mainnet with arbitrary program ID, p50 lag < 500ms.
4. Test suite — unit tests for every parser against on-chain reference data; integration tests for Geyser decoding against recorded streams; e2e smoke test verifying decoding for 60s of live mainnet activity.
5. Documentation — README per package with usage examples; `ap3x-solana/README.md` positioning the substrate as a standalone toolkit; `docs/CONTRIBUTING.md`; `docs/diagnostics/` with probe runner.
6. CI — `pnpm diag --check` in nightly workflow.

## Acceptance criteria (gate)

1. `solana-watch` example runs 1h continuous against live mainnet, subscribing to a variety of programs (SPL Token, SPL Memo, Metaplex Metadata, test pump.fun program), decodes every event with **p50 < 500ms, p99 < 2s**.
2. SPL + Metaplex parsers pass regression suite against 500+ real on-chain accounts covering edge cases (uninitialized, frozen, authority revoked, Token 2022, compressed placeholder).
3. Geyser gap handling: injected 10-slot outage recovers via RPC backfill within 5 slots; no events dropped.
4. Encrypted keypair store round-trip passes property-based tests (encrypt → decrypt → sign → verify); passphrase strength minimums enforced.
5. Priority fee percentiles verified against observed landed fees on 10 sample slots; `turbo` matches p99 ± 10%.
6. Zero runtime dependencies on `@solana/web3.js`, `@solana/spl-token`, `@metaplex-foundation/*`. Verified by `pnpm why` + CI check. Allowed exceptions: `libsodium-wrappers` (crypto), `@noble/ed25519` (off-curve PDA check).
7. CI green on Ubuntu + Windows: lint, typecheck, unit, integration, boundaries, `pnpm diag`.
8. Coverage: 80%+ on packages; 60%+ on the example.

## Key design decisions

- **Solana substrate as independent asset, not pump.fun substrate.** Every primitive in PRP-01 is designed against the question "would a generic Solana agent project want this?" — not "does pump.fun need this?" Pump.fun (PRP-02) is the first validator; Raydium / Orca / Magic Eden are future validators.
- **SPL + Metaplex included from day one, not extracted later.** These are used by nearly every Solana program. "Build what's forced, not imagined" still applies — and what's forced includes these, because pump.fun (PRP-02) needs them and the alternative (build them inline in pump.fun and extract to substrate later) creates a premature-extraction refactor.
- **Zero ecosystem deps.** `@solana/web3.js`, `@solana/kit`, `@solana/spl-token`, `@metaplex-foundation/*` are NOT runtime deps. Hand-rolled parsers on top of `@noble/ed25519` (PDA off-curve check) + `libsodium-wrappers` (keypair crypto) only. Lift from Kit organically when PRP-03's write-path complexity makes hand-rolling VersionedTransaction submission genuinely more expensive.
- **Generic event decoder framework.** Decoders plug in via registry; the substrate owns the framework (log parsing, CPI handling, unknown-variant channel), vertical packages own their program-specific decoders. This is the same pattern `@ap3x/vertical` will codify in PRP-05.
- **Vault lives in the substrate.** Keypair storage is universal to every Solana consumer. Chain-agnostic `@ap3x/vault` extraction waits until Hyperliquid forces the abstraction.
- **Monorepo ships the substrate AND the pump.fun vertical.** `ap3x-solana/` hosts both `@ap3x/solana-*` (substrate) and `@ap3x/pumpfun-*` (vertical, PRP-02+) in the same repo. Rationale: tight dev loop between the two; substrate and first vertical evolve together. Other Solana verticals (Raydium, Orca, Magic Eden) can either join this repo or split into their own later — operator's call per vertical.

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Yellowstone gRPC provider availability | Start with Helius gRPC; fallback to public Solana Geyser; document upgrade path to self-hosted Yellowstone |
| Hand-rolled parsers diverge from on-chain truth | Regression suite against mainnet accounts; nightly diag shape checks; schema-drift CI gate |
| Metaplex format churn (they iterate on metadata layouts) | Zod-style shape validation with version detection; fallback to raw bytes + structured parse-error channel |
| Token 2022 is still evolving | Conservative parser that reads the subset we care about; unknown extensions surface as typed records with `unknown_extensions: Buffer` |
| `libsodium-wrappers` is an external dep | Documented exception in CONTRIBUTING; reviewed quarterly; auditable (single-purpose crypto) |

## Next

On gate pass: **PRP-02 (pump.fun protocol)** unlocks. Any future Solana-venue vertical (Raydium, Orca, Meteora, Magic Eden, Jito) unlocks at this point too — doesn't have to wait for pump.fun.

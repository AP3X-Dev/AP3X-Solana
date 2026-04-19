# PRP-01 — Solana substrate design spec

**Source PRP:** `roadmap/01-solana-substrate.md`
**Author:** CJ (advisor-approved during autonomous run `autonomous-prp-01-2026-04-19`)
**Status:** approved (advisor)

## 1. Goal restatement

Ship `@ap3x/solana-*` — a vertical-agnostic Solana agent toolkit. Seven packages plus an `examples/solana-watch` dogfooding app. Zero ecosystem deps (`@solana/web3.js`, `@solana/spl-token`, `@metaplex-foundation/*` are forbidden as runtime deps). Allowed exceptions: `@noble/ed25519` (PDA off-curve check), `libsodium-wrappers` (vault crypto). v0 transactions only. Hand-rolled parsers regression-tested against real on-chain data.

## 2. Repo + tooling

```
ap3x-solana/
├─ package.json                     # workspace root, private
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ .eslintrc.cjs                    # boundaries plugin enforces layering
├─ .prettierrc
├─ .changeset/                      # changesets-managed releases
├─ .github/workflows/
│   ├─ ci.yml                       # lint, typecheck, test, build, boundaries — Ubuntu + Windows
│   └─ nightly-diag.yml             # pnpm diag --check against live mainnet
├─ packages/
│   ├─ solana-core/
│   ├─ solana-connectivity/
│   ├─ solana-tx/
│   ├─ solana-spl/
│   ├─ solana-metaplex/
│   ├─ solana-events/
│   └─ solana-vault/
├─ examples/
│   └─ solana-watch/
├─ tests/
│   ├─ fixtures/                    # captured on-chain accounts + Geyser streams
│   └─ helpers/                     # shared test utilities
├─ docs/
│   ├─ CONTRIBUTING.md
│   └─ diagnostics/                 # pnpm diag CLI + checks
└─ README.md
```

**Tooling decisions:**

- **pnpm workspaces + Turbo.** Turbo pipelines for `build`, `test`, `lint`, `typecheck`, `diag`. Remote cache off (no Vercel account dep).
- **TypeScript strict mode.** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` in `tsconfig.base.json`. Each package extends.
- **Build:** `tsup` (esbuild-backed) per package. Outputs ESM + CJS + `.d.ts`. Node 20+ minimum.
- **Test:** Vitest + `msw` for HTTP mocking. Coverage via `@vitest/coverage-v8`.
- **Lint:** ESLint flat config + `eslint-plugin-boundaries`. Boundary rules enforce:
  - `core`: imports nothing in the substrate.
  - `connectivity`: may import `core` only.
  - `tx`: may import `core` + `connectivity`.
  - `spl`: may import `core` + `tx` (for `findProgramAddress` only — enforced by a no-restricted-imports rule allowing only that named export from `tx`).
  - `metaplex`: may import `core` + `tx` (same scoped allowance as `spl`).
  - `events`: may import `core` only.
  - `vault`: may import `core` only.
  - Verticals (e.g. `pumpfun-*` in PRP-02) may import any substrate package; substrate may NOT import verticals.
- **Versioning:** **Changesets, fixed/synchronized version across all `@ap3x/solana-*` packages.** Rationale: substrate is a coherent surface; downstream verticals shouldn't have to track 7 independent semvers. (Pump.fun and other verticals get independent versioning when they land.)
- **CI matrix:** Ubuntu-latest + Windows-latest, Node 20.x. Boundaries check + typecheck + unit + integration + build on every PR. Nightly job runs `pnpm diag --check` against live mainnet.
- **Coverage gate:** 80% lines/branches/functions on packages, 60% on `examples/`. CI fails below threshold.

## 3. Package designs

### 3.1 `@ap3x/solana-core`

Universal base layer. Every other substrate package depends on this and only this (within the substrate).

**Public surface:**
- `base58` — `encode(Uint8Array): string`, `decode(string): Uint8Array`. Hand-rolled BigInt-based, validated against test vectors derived from canonical bs58 implementations (vectors checked into repo, generation script under `tests/helpers/`).
- `PublicKey` — class wrapping a 32-byte `Uint8Array`. Methods: `toBase58()`, `toBuffer()`, `equals(other)`, `toString()` (alias for base58). Static: `fromBase58(string)`, `fromBytes(Uint8Array)`. Read-only; no PDA derivation here.
- `Cluster` — `enum Cluster { Mainnet, Devnet, Testnet, Custom }`, `clusterRpcUrl(cluster, customUrl?)`. Endpoints from `solana.com` defaults.
- `compactU16` — `encode(n: number): Uint8Array`, `decode(bytes, offset): { value, length }`. Per Solana shortvec spec, 1–3 bytes.
- `borsh` — minimal codec helpers (NOT schema-driven). Decision: **imperative codec helpers** (option 2 below). Functions: `readU8/U16/U32/U64/I64`, `readBool`, `readBytes(n)`, `readVec(itemReader)`, `readOption(itemReader)`, `readPubkey`, `readString`. Symmetric `write*` helpers. A `Reader` class wraps `{ buf, offset }`. Schemas live in consumer packages as composed reader functions, e.g. `function readMintAccount(r: Reader): TokenMint`.
- `errors` — base `Ap3xError` extending `Error` with `cause`, `code`. Subclasses: `RpcError(code: 'timeout'|'rate_limited'|'http'|'rpc_method'|'parse', meta)`, `DecodingError(meta: {programId?, accountKey?, byteOffset?, expected, actual})`, `TimeoutError`, `ConfigError`. All carry structured metadata (no string-only errors).
- `HttpClient` — lifted+relicensed from Chad PRP-1. Constructor: `{ baseUrl?, timeoutMs, retry: { attempts, backoffMs, jitter }, circuitBreaker: { failureThreshold, recoveryMs } }`. Methods: `get(path, opts)`, `post(path, body, opts)`, `request(method, path, init)`. Emits a `metrics` event per request with `{latencyMs, statusCode, errorClass, retryCount}`. `EventEmitter`-based.

**Why imperative-codec Borsh-lite:** Schema-driven decoders couple decode logic to schema state at decoder-build time. Imperative readers compose into hand-rolled per-account decoders that live next to the type they decode — easier to debug a parser-vs-on-chain discrepancy when the decode is one function you can step through. Cost: more boilerplate; mitigated by good helpers. PRP says "minimal binary-layout primitives" — imperative wins.

**Tests:** vector-driven for base58 + compact-u16 (canonical vectors). Property-based for round-trip on PublicKey/HttpClient retries. HttpClient circuit-breaker behavior tested with `msw` failure injection.

### 3.2 `@ap3x/solana-connectivity`

**Public surface:**
- `RpcPool` — constructor `{ endpoints: RpcEndpoint[], strategy: 'roundRobinReads' (default) }` where `RpcEndpoint = { name: 'helius'|'triton'|'quicknode'|'custom', url: string, kind: 'http'|'gRPC', weight?: number }`. Methods: `call<M extends RpcMethod>(method: M, params, opts?)` for read; `pinForWrite(): RpcEndpoint` for the write path (returns lowest-latency healthy endpoint). Internal: `LatencyTracker` (EWMA over last 50 calls), `HealthState` (`healthy|degraded|unhealthy`, transition rules: 5 consecutive errors → degraded, 10 consecutive errors → unhealthy, 1 success → healthy). Emits `metrics` events identical to HttpClient with added `{ endpoint, healthState }`.
- `GeyserClient` — Yellowstone gRPC client. Constructor `{ endpoint: { url, token? }, checkpointStore: CheckpointStore }`. Methods: `subscribe(req: SubscribeRequest, handler: (update) => void): Subscription`. `SubscribeRequest` covers accounts/transactions/slots/blocks per Yellowstone proto; types generated via `proto-loader` against the upstream `.proto` file (vendored, version-pinned). Backpressure: bounded internal queue (default 1000 items), drop-oldest with a `dropped` event carrying `{ count, since }`. Gap detection: tracks last-seen slot; on jump > 1, emits `gap` event and (optionally) calls `RpcPool.call('getBlocks', [from, to])` to fill. Checkpoint: persisted via `CheckpointStore` interface.
- `CheckpointStore` — interface `{ load(key): Promise<Checkpoint|null>, save(key, ckpt): Promise<void> }`. **Default backend: file-based** (single JSON per subscription key in `.ap3x/geyser-checkpoints/`). Decision: **pluggable interface with file as default** — keeps zero-dep posture, lets ops swap to Redis/SQLite without forking. SQLite/Redis adapters not shipped in PRP-01.
- `RpcHistoricalBackfill` — typed wrappers `getSignaturesForAddress(addr, opts)`, `getTransaction(sig, opts)`, `getBlocks(from, to)`. Helper `fetchEventsForProgram(programId, slotRange, decoder)` that yields decoded events lazily (async iterable). Pagination + checkpointing built in.
- CLI `pnpm diag` — `packages/solana-connectivity/src/diag/cli.ts`, exposed as `bin: { ap3x-solana-diag: "./dist/diag/cli.js" }` from a top-level package or via `examples/solana-watch`. Subcommands: `probe-rpc <endpoint>`, `probe-geyser <endpoint>`, `compare-providers <a> <b>`, `--check` (CI mode, exit non-zero on failure).

**Tests:** RpcPool failover tested with `msw`-injected HTTP failures and a fake clock; latency-scoring matched against deterministic test fixtures. Geyser tested against recorded streams (binary `.bin` fixtures replayed via a fake gRPC server harness) — gap detection verified by injecting slot skips into recordings.

### 3.3 `@ap3x/solana-tx`

**Public surface:**
- `findProgramAddress(seeds: Uint8Array[], programId: PublicKey): { address: PublicKey, bump: number }` — hand-rolled. Uses `@noble/ed25519` `utils.isValidPoint` for off-curve check.
- `AddressLookupTable` — `decode(account: AccountInfo): AltState`, `findInstructionsForKeys(...)` helpers. Builders in PRP-03 if needed; PRP-01 is read-side only.
- `priorityFee` — `PriorityFeeEstimator` constructor `{ geyser: GeyserClient, windowSlots: number = 150 }`. Subscribes to slot updates + tx fees via Geyser. Exposes `tier(t: 'low'|'med'|'high'|'turbo'): { microLamportsPerCu: bigint, asOfSlot: number }`. Recomputed every slot. Initial-state behavior: returns conservative defaults until first 30 slots observed.
- `computeBudget` — `simulateAndBudget(rpcPool, tx, payer)` returns `{ unitsConsumed, unitsLimit: unitsConsumed * 1.15 }`. Stub in PRP-01 (logs a TODO if simulation fails); full implementation in PRP-03.
- `TransactionAssembler` — `assemble({ instructions, payer, signers, recentBlockhash, alts? }): Uint8Array`. Outputs serialized v0 message bytes. Does NOT sign. Caller signs via `WalletHandle.sign(message)`.
- `JitoBundleBuilder` — `compose(txs: SignedTransaction[]): Bundle` (max 5 per Jito spec). Helpers for tip instruction (`tipInstruction(tipAccount, lamports)`). **No dispatcher** — actual submission gated to PRP-03.

**Boundaries:** `tx` may import `core` + `connectivity` (needs `RpcPool` for sim and `GeyserClient` for fee feed).

**Tests:** PDA derivation tested against canonical Anchor PDAs (vectors in `tests/fixtures/pdas.json`). Compute-budget logic tested with simulated `SimulateTransactionResponse`. Priority-fee estimator tested with synthetic Geyser fee streams + known percentile expectations.

### 3.4 `@ap3x/solana-spl`

**Public surface:**
- `TokenMint` type + `decodeMint(account: AccountInfo): TokenMint` — fields: `decimals, supply (bigint), mintAuthority (PublicKey|null), freezeAuthority (PublicKey|null), isInitialized, tokenProgram: 'spl-v1'|'token-2022'`.
- `TokenAccount` type + `decodeTokenAccount(account: AccountInfo): TokenAccount` — fields: `owner, mint, amount (bigint), delegate (PublicKey|null), state ('uninitialized'|'initialized'|'frozen'), tokenProgram`.
- Token-2022 detection by program ID + extension parsing for known extensions (`MintCloseAuthority`, `TransferFeeConfig`, `DefaultAccountState`). Unknown extensions surface in a `unknownExtensions: Buffer` field, never silently dropped.
- ATA derivation: `getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve = false): PublicKey` — uses `findProgramAddress` from `@ap3x/solana-tx`. **Decision:** `solana-spl` may import `solana-tx` for PDA derivation. Updated boundary rule: `spl` and `metaplex` may import `core` and the PDA helper from `tx`. (Alternative: copy PDA derivation into core; rejected — duplicate code is worse than relaxed boundary for a single helper.)
- `createAssociatedTokenAccountIx(payer, owner, mint): TransactionInstruction` — instruction builder.
- `getTokenLargestAccounts(rpc, mint, limit?)`, `getTokenAccountsByMint(rpc, mint, opts?)` — typed wrappers around `RpcPool` calls.

**Tests:** parsers tested against 500+ recorded mainnet accounts (committed as compressed fixtures `tests/fixtures/spl-accounts.json.gz`, decompressed in test setup). Edge cases: uninitialized, frozen, authority revoked (= null pubkey), Token 2022 with each known extension, Token 2022 with synthetic unknown extension.

### 3.5 `@ap3x/solana-metaplex`

**Public surface:**
- `getMetadataPda(mint): PublicKey` — derives Token Metadata Program PDA.
- `decodeMetadata(account: AccountInfo): Metadata` — handles all three on-chain layouts (v1, v1.3, current). Version-detected by reading the `key` discriminator + length prefix logic. Fields: `mint, updateAuthority, name, symbol, uri, sellerFeeBasisPoints, creators[], collection?, uses?, primarySaleHappened, isMutable, editionNonce?`.
- `MetadataResolver` — fetches off-chain JSON via `HttpClient`, validates shape with a hand-rolled validator (no Zod — zero-dep posture). Returns `{ raw, parsed?: OffchainMetadata, parseErrors?: ParseError[] }` — never throws on malformed JSON. LRU cache (default 500 entries) + optional file-backed cache directory.
- Collection helpers: `isCollectionMember(child: Metadata, parent: PublicKey): boolean`, `verifyCreator(metadata, creator: PublicKey): boolean`.
- cNFT: stub interface `interface CompressedMetadataReader { read(asset: PublicKey): Promise<Metadata|null> }` with a default `throw new Error('cNFT support deferred to magic-eden vertical')` implementation. Real implementation in a future Magic Eden vertical PRP.

**Tests:** decoder tested against 200+ recorded metadata accounts spanning all three layouts. Off-chain resolver tested with `msw` returning malformed JSON, missing fields, valid v1, valid current; cache behavior verified with parameterized eviction tests.

### 3.6 `@ap3x/solana-events`

**Public surface:**
- `EventDecoderRegistry` — class. Methods: `register(programId: PublicKey | string, decoder: ProgramDecoder)`, `decode(logs: TransactionLog): DecodedEventStream`. Decision: **registry instances, NOT a global singleton.** Consumers create a registry, register decoders, pass it where needed. Rationale: testability + multiple decoder configurations per process.
- `ProgramDecoder` interface: `{ programId: PublicKey, decode(logChunk: ProgramLogChunk): EventUnion | UnknownEventDecode }`.
- `parseLogs(logs: string[]): TransactionLog` — handles `Program <id> invoke [n]` / `Program <id> success/failed` / `Program log:` / `Program data: <base64>` / `Program return: <id> <base64>` per Solana log conventions. Returns a structured `TransactionLog` with nested `ProgramLogChunk[]` capturing CPI hierarchy.
- `EventUnion` is a generic — vertical packages discriminate via a `kind` field.
- `UnknownEventDecode` type — `{ kind: 'unknown', programId, raw: ProgramLogChunk, reason: string }` emitted in a separate channel of `DecodedEventStream` so consumers can route it to a structured-error sink without losing it.
- Helpers: `decodeBase64Data(s: string): Uint8Array` for `Program data:` payloads.

**Tests:** synthetic log inputs covering: simple invoke, nested CPI (3 levels deep), failed inner invoke, mixed `Program log` and `Program data` lines, malformed payloads, unknown program. Real fixtures captured from mainnet for SPL Token + Memo programs.

### 3.7 `@ap3x/solana-vault`

**Public surface:**
- `Vault` — constructor `{ storage: VaultStorage, kdf?: { iterationsM, memoryKb, parallelism } }`. Methods: `addWallet(name, role, secretKey, passphrase)`, `unlock(name, passphrase): Promise<WalletHandle>`, `lock(name)`, `rotateKey(name, oldPp, newPp)`, `list(): WalletMetadata[]`, `audit(name): Promise<AuditEntry[]>`.
- `WalletHandle` — opaque. Methods: `sign(message: Uint8Array): Promise<Uint8Array>`, `signTransaction(tx: Uint8Array): Promise<Uint8Array>`, `address: PublicKey`, `role: string`. **Never exposes raw secret bytes.**
- `VaultStorage` — interface `{ read(name): Promise<EncryptedRecord|null>, write(name, rec): Promise<void>, list(): Promise<string[]>, appendAudit(name, entry): Promise<void>, readAudit(name): Promise<AuditEntry[]> }`. **Default backend: file-based** in `~/.ap3x/vault/<name>.json`. Decision: **JSON-with-base64-encoded-fields** (option 1 from design Q&A). Rationale: human-inspectable, easy to back up; binary container is overkill for a single encrypted blob and complicates ops.
- Encryption: `libsodium-wrappers` `crypto_secretbox_easy`. Key derivation: Argon2id (`crypto_pwhash`) with `OpsLimit = MODERATE`, `MemLimit = MODERATE` (~64 MiB) — tunable via Vault constructor.
- `EncryptedRecord` shape: `{ version: 1, name, role, address, kdf: { algo: 'argon2id', salt: base64, opslimit, memlimit }, encryption: { algo: 'xsalsa20-poly1305', nonce: base64, ciphertext: base64 }, createdAt }`.
- SOL reserve guard: `Vault` constructor accepts `solReserveByRole: { [role]: bigint }` (lamports). `WalletHandle.signTransaction` rejects with `WalletReserveBreach` if the resulting balance after estimated fees + transfers would drop below the reserve. (Implementation note: reserve check is a soft policy — full circuit-breaker integration lives in PRP-03.)
- Audit log: append-only `~/.ap3x/vault/<name>.audit.jsonl`. Entries: `{ timestamp, event: 'unlock'|'sign'|'rotate'|'create', metadata }`.
- Passphrase strength: minimum 12 chars, require ≥3 of {lower, upper, digit, symbol}. Enforced at `addWallet` and `rotateKey`. Configurable via `Vault({ passphrasePolicy })`.

**Tests:** property-based round-trip (encrypt → decrypt → sign → verify) using `fast-check`. Passphrase-policy enforcement tested across edge cases. Audit log append durability tested with simulated process kills (write-then-fsync verified).

### 3.8 `examples/solana-watch`

~100 LOC Node script. CLI flags: `--program <pubkey>` (required, repeatable), `--rpc <url>` (required), `--geyser <url>` (required), `--decoder <name>` (optional, defaults to spl+metaplex). Subscribes via Geyser, decodes via registered SPL + Metaplex decoders (registered in the script for PRP-01 — pump.fun decoders register here once PRP-02 lands), prints `{slot, programId, kind, latencyMs}` JSON-per-line to stdout. Latency = `now - blockTimeFromSlot`.

Includes a `Dockerfile` for the 1h continuous-run acceptance test.

## 4. Cross-cutting concerns

### 4.1 Metrics

Every package emits `metrics` events on a shared `EventEmitter` instance available via `@ap3x/solana-core`'s `metrics` export. Standard payload `{ ts, package, op, latencyMs?, errorClass?, meta }`. No metrics backend ships with PRP-01 — consumers attach their own listener (the example app prints them).

### 4.2 Concurrency

All async operations honor an `AbortSignal`. Long-running streams (Geyser) accept a `signal` parameter on `subscribe()` and clean up on abort.

### 4.3 Error handling

- Decoders never throw on malformed input — they return structured error records (`UnknownEventDecode`, `DecodingError`, `parseErrors`).
- Network operations throw typed `RpcError` with `code` discriminating retryable vs. terminal. Caller decides retry policy (HttpClient + RpcPool implement defaults).
- All thrown errors have a `.code` and structured `.meta`.

### 4.4 Logging

No package logs to stdout/stderr directly. Instead, packages emit structured events (see Metrics). Consumers wire logging.

### 4.5 Diagnostics CLI (`pnpm diag`)

Subcommands above. `--check` mode runs a battery of probes and exits non-zero on any failure. Used in nightly CI workflow.

## 5. Test strategy

- **Unit tests** per package, colocated `__tests__` or `*.test.ts` (Vitest auto-discovers).
- **Integration tests** in each package against captured fixtures (live calls forbidden in CI default; gated behind `INTEGRATION_LIVE=1`).
- **E2E test** in `examples/solana-watch/test/e2e.test.ts` runs the example for 60 seconds against live mainnet (requires `RPC_URL` and `GEYSER_URL` env vars; skipped in default CI, run nightly).
- **1h acceptance run** scripted as `examples/solana-watch/scripts/acceptance.sh` — invoked manually with mainnet creds; produces a JSON report.
- **Fixture management:** capture scripts under `tests/helpers/capture/` produce reproducible fixtures from mainnet. Capture scripts NOT run in CI; fixtures committed to repo (gz-compressed where >100KB).

## 6. Acceptance gate handling

| Gate | Verification in PRP-01 run | Deferred to optimization loop / future |
|---|---|---|
| 1. solana-watch 1h continuous, p50<500ms p99<2s | Code shipped, but live run skipped (no RPC credentials) | Backlog item: run acceptance script when Helius creds provided |
| 2. SPL+Metaplex parsers vs 500+ accounts | Fixtures captured + tests pass | — |
| 3. Geyser gap recovery within 5 slots | Synthetic gap tests pass against fake stream | Backlog: live gap test once Geyser endpoint configured |
| 4. Vault round-trip property tests | Pass | — |
| 5. Priority fee p99 ± 10% vs landed fees | Synthetic test passes; live verification deferred | Backlog: 10-slot live sample once RPC configured |
| 6. Zero forbidden runtime deps | CI gate via `pnpm why @solana/web3.js` etc. | — |
| 7. CI green Ubuntu+Windows | Required to pass before PR | — |
| 8. Coverage 80% pkg / 60% example | Required to pass before PR | — |

## 7. Out of scope (per PRP)

- pump.fun decoders, curve math, typed client → PRP-02
- Write-path execution + receipts + Jito dispatcher → PRP-03
- Policy engine, tiers, circuit breakers (beyond vault SOL reserve) → PRP-03
- Event store + signal layer → PRP-04
- Other Solana-venue verticals → separate PRPs

## 8. Risks (carried from PRP)

Mitigations as specified in PRP. Additional design-level mitigation: schema-drift CI gate checks SPL+Metaplex fixture freshness monthly (alerts if no fixture refresh in 30d via a CI cron).

## 9. Design decisions log (autonomous-advisor decisions)

| Decision | Choice | Rationale |
|---|---|---|
| Workspace versioning | Fixed/synchronized via Changesets | Substrate is a coherent surface; downstream consumers shouldn't track 7 semvers |
| Borsh-lite shape | Imperative codec helpers + Reader class | Easier to debug parser-vs-on-chain discrepancies; matches PRP "minimal" |
| Geyser checkpoint backend | Pluggable interface, file as default | Keeps zero-dep posture, allows ops to swap without forking |
| Vault container format | JSON with base64-encoded fields | Human-inspectable; binary container is overkill for one blob |
| Event decoder registry | Instance-based, no singleton | Testability + multi-config support |
| spl/metaplex importing tx | Allowed for PDA helper only | Better than duplicating PDA derivation into core |
| Build tool | tsup (esbuild) | Fast, dual ESM+CJS, low-config |
| HTTP test mocking | msw | Standard, well-supported |
| Property-based test lib | fast-check | Standard for JS/TS, zero peer deps |

## 10. Implementation handoff

This spec hands off to `superpowers:writing-plans` to produce `docs/superpowers/plans/2026-04-19-prp-01-solana-substrate-plan.md`. The plan will:

1. Order package implementation respecting layering (`core` → `connectivity`/`vault` → `tx` → `spl`/`metaplex` → `events` → `examples`).
2. Identify parallelizable tasks.
3. Mark TDD checkpoints per package.
4. Identify fixture-capture tasks (must complete before parser tests).

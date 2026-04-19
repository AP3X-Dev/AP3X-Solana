# PRP-01 Solana substrate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers ALSO receive the spec at `docs/superpowers/specs/2026-04-19-prp-01-solana-substrate-design.md` and the source PRP at `roadmap/01-solana-substrate.md` — pull detail from there when a step references "per spec section X.Y".

**Goal:** Ship `@ap3x/solana-*` (7 packages) plus `examples/solana-watch` — a vertical-agnostic Solana agent toolkit with zero ecosystem deps, v0 transactions only, hand-rolled parsers, and an encrypted vault.

**Architecture:** pnpm workspaces + Turbo monorepo. `solana-core` is the universal base. `connectivity`, `vault` build on `core`. `tx` builds on `core` + `connectivity`. `spl`, `metaplex` build on `core` + scoped PDA helper from `tx`. `events` builds on `core`. Generic event decoder framework with instance-based registry; verticals plug in program-specific decoders.

**Tech Stack:** TypeScript 5.4+, Node 20+, pnpm 9+, Turbo 2+, Vitest, msw, fast-check, tsup (build), `@noble/ed25519`, `libsodium-wrappers`, `@grpc/grpc-js` + `@grpc/proto-loader` (Yellowstone gRPC), Changesets (releases), ESLint flat + `eslint-plugin-boundaries`.

**Acceptance gates (per Option A):**
- Verified in-run: gates 4 (vault round-trip), 6 (zero forbidden deps), 7 (CI green), 8 (coverage)
- Backlog (gated on Helius/Triton/QuickNode credentials): gates 1 (1h continuous mainnet), 2 (500-account regression — capture script ships, capture run deferred), 3 (live Geyser gap recovery), 5 (priority fee p99 vs landed)

---

## File Structure (locked)

```
ap3x-solana/
├─ package.json                              [Task 1]
├─ pnpm-workspace.yaml                       [Task 1]
├─ turbo.json                                [Task 1]
├─ tsconfig.base.json                        [Task 1]
├─ eslint.config.js                          [Task 35]
├─ .prettierrc                               [Task 1]
├─ .changeset/config.json                    [Task 1]
├─ .github/workflows/ci.yml                  [Task 35]
├─ .github/workflows/nightly-diag.yml        [Task 35]
├─ packages/
│  ├─ solana-core/                           [Tasks 2-9]
│  │  ├─ package.json, tsconfig.json, tsup.config.ts
│  │  └─ src/
│  │     ├─ index.ts                         (re-exports)
│  │     ├─ base58.ts                        [Task 2]
│  │     ├─ public-key.ts                    [Task 3]
│  │     ├─ cluster.ts                       [Task 4]
│  │     ├─ compact-u16.ts                   [Task 5]
│  │     ├─ borsh.ts                         [Task 6]
│  │     ├─ errors.ts                        [Task 7]
│  │     ├─ http-client.ts                   [Task 8]
│  │     └─ metrics.ts                       [Task 9]
│  ├─ solana-vault/                          [Tasks 10-12]
│  │  └─ src/{index,crypto,vault,wallet-handle,reserve-guard,audit,storage-file}.ts
│  ├─ solana-connectivity/                   [Tasks 13-17]
│  │  └─ src/{index,rpc-pool,latency-tracker,health-state,geyser-client,checkpoint-store-file,historical-backfill,proto/yellowstone}.ts
│  │  └─ src/diag/{cli,probes}.ts
│  ├─ solana-tx/                             [Tasks 18-23]
│  │  └─ src/{index,find-program-address,address-lookup-table,priority-fee,compute-budget,transaction-assembler,jito-bundle}.ts
│  ├─ solana-spl/                            [Tasks 24-26]
│  │  └─ src/{index,mint,token-account,token-2022-extensions,ata,holder-queries}.ts
│  ├─ solana-metaplex/                       [Tasks 27-29]
│  │  └─ src/{index,metadata-pda,metadata-decoder,resolver,collection,cnft-stub}.ts
│  └─ solana-events/                         [Tasks 30-31]
│     └─ src/{index,parse-logs,registry,cpi-decoder}.ts
├─ examples/solana-watch/                    [Task 32]
│  └─ src/{main,Dockerfile}
├─ tests/
│  ├─ fixtures/                              [Tasks 33-34]
│  └─ helpers/capture/                       [Tasks 33-34]
└─ docs/{CONTRIBUTING.md, diagnostics/}
```

---

## Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.prettierrc`, `.changeset/config.json`, `.npmrc`
- Create: `README.md` (substrate-positioning short version), `docs/CONTRIBUTING.md`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "ap3x-solana",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20.0.0" },
  "workspaces": ["packages/*", "examples/*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "test:integration": "turbo run test:integration",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "diag": "pnpm --filter @ap3x/solana-connectivity diag",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "turbo run build && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.7",
    "@types/node": "^20.14.0",
    "eslint": "^9.10.0",
    "eslint-plugin-boundaries": "^4.2.2",
    "prettier": "^3.3.3",
    "tsup": "^8.3.0",
    "turbo": "^2.1.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@vitest/coverage-v8": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
  - 'examples/*'
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "test:integration": { "dependsOn": ["^build"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "diag": { "cache": false }
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": false
  }
}
```

- [ ] **Step 5: Create `.prettierrc`**

```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100, "semi": true }
```

- [ ] **Step 6: Create `.changeset/config.json`**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [["@ap3x/solana-*"]],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["solana-watch"]
}
```

- [ ] **Step 7: Create `.npmrc`**

```
auto-install-peers=true
strict-peer-dependencies=false
```

- [ ] **Step 8: Create `README.md`**

Short positioning README — see spec Section 1. Mention `@ap3x/solana-*` as a generic Solana agent toolkit, link to PRP-01, list packages.

- [ ] **Step 9: Create `docs/CONTRIBUTING.md`**

Cover: zero-deps rule, allowed exceptions (`@noble/ed25519`, `libsodium-wrappers`), commit message style (no AI attribution per global CLAUDE.md), changeset workflow, how to run `pnpm diag`, how to capture fixtures.

- [ ] **Step 10: Run `pnpm install` to generate lockfile**

```bash
pnpm install
```

Expected: lockfile created, no errors.

- [ ] **Step 11: Commit**

```bash
git add .
git commit -m "PRP-01: monorepo scaffold (pnpm + turbo + tsconfig + changesets)"
```

---

## Task 2: `solana-core` — base58

**Files:**
- Create: `packages/solana-core/{package.json, tsconfig.json, tsup.config.ts, vitest.config.ts}`
- Create: `packages/solana-core/src/{index.ts, base58.ts}`
- Create: `packages/solana-core/src/base58.test.ts`
- Create: `packages/solana-core/tests/fixtures/base58-vectors.json`

- [ ] **Step 1: Scaffold the package**

`packages/solana-core/package.json`:
```json
{
  "name": "@ap3x/solana-core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run --coverage",
    "test:watch": "vitest",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/solana-core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*"], "compilerOptions": { "outDir": "dist", "rootDir": "src" } }
```

`packages/solana-core/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, clean: true, sourcemap: true });
```

`packages/solana-core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { coverage: { provider: 'v8', thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 } } } });
```

- [ ] **Step 2: Generate base58 test vectors**

Add ~50 known input/output pairs to `tests/fixtures/base58-vectors.json` covering: empty, single byte (0x00, 0xff), 32-byte zero PublicKey, 32-byte all-ones, leading zeros, common Solana program IDs (TOKEN_PROGRAM, SYSTEM_PROGRAM, METAPLEX_PROGRAM), randomly-generated 64-byte signatures.

- [ ] **Step 3: Write the failing test**

`packages/solana-core/src/base58.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import vectors from '../tests/fixtures/base58-vectors.json' assert { type: 'json' };
import { encode, decode } from './base58';

describe('base58', () => {
  for (const v of vectors) {
    it(`encodes ${v.label}`, () => {
      expect(encode(new Uint8Array(v.bytes))).toBe(v.encoded);
    });
    it(`decodes ${v.label}`, () => {
      expect(Array.from(decode(v.encoded))).toEqual(v.bytes);
    });
  }
  it('round-trips random 32-byte values', () => {
    for (let i = 0; i < 1000; i++) {
      const buf = crypto.getRandomValues(new Uint8Array(32));
      expect(Array.from(decode(encode(buf)))).toEqual(Array.from(buf));
    }
  });
  it('throws on invalid char', () => {
    expect(() => decode('0OIl')).toThrow();
  });
});
```

- [ ] **Step 4: Run test — should fail**

`pnpm --filter @ap3x/solana-core test`. Expected: FAIL (`encode`/`decode` not exported).

- [ ] **Step 5: Implement `base58.ts`**

Standard BigInt-based bs58 encoder/decoder using the Bitcoin alphabet (`123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`). Handle leading zero bytes (encode as leading '1's). Validate alphabet on decode.

- [ ] **Step 6: Add `index.ts` re-export**

```ts
export * from './base58';
```

- [ ] **Step 7: Run tests — pass**

`pnpm --filter @ap3x/solana-core test`. Expected: PASS, coverage ≥80%.

- [ ] **Step 8: Commit**

```bash
git add packages/solana-core
git commit -m "solana-core: base58 encode/decode + vector tests"
```

---

## Task 3: `solana-core` — PublicKey

**Files:**
- Create: `packages/solana-core/src/public-key.ts`
- Create: `packages/solana-core/src/public-key.test.ts`

- [ ] **Step 1: Write tests** for `PublicKey.fromBase58`, `fromBytes`, `toBase58`, `toBuffer`, `equals`, `toString`. Include known on-chain pubkeys (TOKEN_PROGRAM, SYSTEM_PROGRAM, etc.) as fixtures. Reject inputs of incorrect byte length.

- [ ] **Step 2: Run tests — fail**

- [ ] **Step 3: Implement** `class PublicKey` per spec Section 3.1. Read-only. Wraps a `Uint8Array(32)`. Use base58 from Task 2.

- [ ] **Step 4: Re-export** from `index.ts`.

- [ ] **Step 5: Run tests — pass**

- [ ] **Step 6: Commit**

```bash
git commit -am "solana-core: PublicKey class"
```

---

## Task 4: `solana-core` — Cluster

**Files:** `packages/solana-core/src/cluster.ts` + test.

- [ ] **Step 1: Write tests** for `Cluster` enum and `clusterRpcUrl(cluster, customUrl?)`. Default URLs: mainnet=`https://api.mainnet-beta.solana.com`, devnet=`https://api.devnet.solana.com`, testnet=`https://api.testnet.solana.com`, custom=throws if no URL provided.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** per spec Section 3.1.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 5: `solana-core` — compactU16

**Files:** `packages/solana-core/src/compact-u16.ts` + test.

- [ ] **Step 1: Write tests** with known shortvec encodings: `0 → [0x00]`, `127 → [0x7f]`, `128 → [0x80, 0x01]`, `16383 → [0xff, 0x7f]`, `16384 → [0x80, 0x80, 0x01]`, `65535 → [0xff, 0xff, 0x03]`. Include round-trip property test with random values 0..65535.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** `encode(n: number): Uint8Array` and `decode(bytes: Uint8Array, offset: number): { value: number, length: number }` per Solana shortvec spec.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 6: `solana-core` — borsh codec helpers + Reader

**Files:** `packages/solana-core/src/borsh.ts` + test.

- [ ] **Step 1: Write tests** covering the `Reader` class (`new Reader(buf)`, `r.offset`, `r.remaining()`) plus all primitive readers/writers per spec Section 3.1: `readU8/U16/U32/U64/I64/Bool`, `readBytes(n)`, `readVec(itemReader)`, `readOption(itemReader)`, `readPubkey()`, `readString()`, and matching `write*` symmetric helpers via a `Writer` class. U64/I64 return `bigint`. Pubkey readers return `PublicKey`. `readString` reads u32 length-prefixed UTF-8.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** `borsh.ts` per spec. Use `DataView` for numeric reads. `readPubkey` consumes 32 bytes. `Reader` mutates `offset` on each read.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 7: `solana-core` — errors

**Files:** `packages/solana-core/src/errors.ts` + test.

- [ ] **Step 1: Write tests** verifying: `Ap3xError` extends `Error` with `cause`, `code`. Subclasses (`RpcError`, `DecodingError`, `TimeoutError`, `ConfigError`) preserve `cause`, expose `meta`. `instanceof` checks work.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** per spec Section 3.1. `RpcError` `code: 'timeout'|'rate_limited'|'http'|'rpc_method'|'parse'`. `DecodingError` `meta: { programId?, accountKey?, byteOffset?, expected, actual }`.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 8: `solana-core` — HttpClient

**Files:** `packages/solana-core/src/http-client.ts` + test (using `msw`).

Add `msw` to root devDependencies (`pnpm add -Dw msw`).

- [ ] **Step 1: Write tests** covering: success path; retry on 5xx + network failure with exponential backoff + jitter; timeout abort; circuit breaker opens after threshold consecutive failures, half-opens after recoveryMs, closes after success; emits `metrics` events with `{ latencyMs, statusCode, errorClass, retryCount }`.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** `HttpClient` per spec Section 3.1. Use `fetch` (native in Node 20+) + `AbortController` for timeout. EventEmitter base. Retry loop with `await delay(backoff(attempt) + jitter)`. Circuit-breaker state machine (`closed → open → half-open`).

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 9: `solana-core` — metrics emitter

**Files:** `packages/solana-core/src/metrics.ts` + test.

- [ ] **Step 1: Write tests** verifying a shared `metrics` `EventEmitter` instance is exported; subscribers receive `{ ts, package, op, latencyMs?, errorClass?, meta }` payloads; `emit(event)` is a typed helper.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** singleton `EventEmitter` exported as `metrics`. Provide a `MetricEvent` type. Provide `emitMetric(event: MetricEvent)` helper.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 10: `solana-vault` — encryption + Argon2id

**Files:**
- Create: `packages/solana-vault/{package.json, tsconfig.json, tsup.config.ts, vitest.config.ts}` (mirror solana-core)
- Create: `packages/solana-vault/src/{index.ts, crypto.ts}`
- Create: `packages/solana-vault/src/crypto.test.ts`

Add `libsodium-wrappers` + `@noble/ed25519` to package deps.

- [ ] **Step 1: Scaffold** package mirroring solana-core layout. Add `dependencies: { "@ap3x/solana-core": "workspace:*", "libsodium-wrappers": "^0.7.13", "@noble/ed25519": "^2.1.0" }`.

- [ ] **Step 2: Write tests** for `crypto.ts`: `deriveKey(passphrase, salt, opslimit, memlimit)` returns 32 bytes; `encrypt(key, plaintext) → { nonce, ciphertext }`; `decrypt(key, nonce, ciphertext) → plaintext`; round-trips with random keys/data; `decrypt` throws on tampered ciphertext.

- [ ] **Step 3: Run — fail**

- [ ] **Step 4: Implement** `crypto.ts` using `libsodium-wrappers`:

```ts
import sodium from 'libsodium-wrappers';
export async function ready() { await sodium.ready; }
export async function deriveKey(passphrase: string, salt: Uint8Array, opslimit: number, memlimit: number): Promise<Uint8Array> {
  await ready();
  return sodium.crypto_pwhash(32, passphrase, salt, opslimit, memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13);
}
export async function encrypt(key: Uint8Array, plaintext: Uint8Array) {
  await ready();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  return { nonce, ciphertext };
}
export async function decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  await ready();
  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
}
```

- [ ] **Step 5: Re-export.**

- [ ] **Step 6: Run — pass.**

- [ ] **Step 7: Commit.**

---

## Task 11: `solana-vault` — Vault + WalletHandle

**Files:** `packages/solana-vault/src/{vault.ts, wallet-handle.ts, storage-file.ts}` + tests.

- [ ] **Step 1: Write tests** covering: `Vault.addWallet(name, role, secretKey, passphrase)` writes encrypted record; `unlock(name, passphrase)` returns a `WalletHandle`; `lock(name)` clears in-memory key; `WalletHandle.sign(message)` signs ed25519; `WalletHandle.signTransaction(txBytes)` signs the message digest; `WalletHandle.address` exposes the public key; raw secret key never exposed via any handle method; passphrase-policy enforcement (≥12 chars, ≥3 of {lower, upper, digit, symbol}); fast-check property test for encrypt → decrypt → sign → verify on 100 random keypairs.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** `wallet-handle.ts`: opaque class holding decrypted secret key (32 bytes ed25519 seed) in a closure, `sign()` uses `@noble/ed25519` `sign()`, `signTransaction()` derives signature over `tx[1..]` (skip the signature count byte) per Solana v0 conventions and returns the signed serialization. `address: PublicKey`.

- [ ] **Step 4: Implement** `storage-file.ts`: `FileVaultStorage` constructor `{ baseDir }`. Reads/writes JSON-with-base64 fields per spec Section 3.7. `appendAudit` writes a JSONL line via `fs.appendFile`. Default baseDir: `~/.ap3x/vault/`.

- [ ] **Step 5: Implement** `vault.ts` orchestrating storage + crypto + wallet-handle. Enforce passphrase policy. Argon2id moderate defaults from libsodium constants.

- [ ] **Step 6: Re-export.**

- [ ] **Step 7: Run — pass, verify property tests.**

- [ ] **Step 8: Commit.**

---

## Task 12: `solana-vault` — SOL reserve guard + audit + rotation

**Files:** `packages/solana-vault/src/{reserve-guard.ts, audit.ts}` + tests; extend `vault.ts` and `wallet-handle.ts`.

- [ ] **Step 1: Write tests** for: `reserve-guard.checkSpend({ wallet, txEstimatedDelta, currentBalance, reserveLamports }) → { ok, reason? }`; `WalletHandle.signTransaction` rejects with `WalletReserveBreach` if guard returns `!ok` (the handle accepts an optional `getBalance: () => Promise<bigint>` and `estimateDelta: (tx) => bigint` injected at unlock time). Audit log: `audit('unlock'|'sign'|'rotate'|'create', meta)` appends to JSONL; `Vault.audit(name)` reads back. `rotateKey(name, oldPp, newPp)` re-encrypts under new passphrase; old passphrase no longer unlocks.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** `reserve-guard.ts` (pure function), `audit.ts` (append + read), extend `vault.ts` + `wallet-handle.ts`.

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Commit.**

---

## Task 13: `solana-connectivity` — RpcPool

**Files:**
- Create: `packages/solana-connectivity/{package.json, tsconfig.json, tsup.config.ts, vitest.config.ts}` (mirror)
- Create: `packages/solana-connectivity/src/{index.ts, rpc-pool.ts, latency-tracker.ts, health-state.ts}` + tests.

Dep: `@ap3x/solana-core: workspace:*`.

- [ ] **Step 1: Scaffold package.**

- [ ] **Step 2: Write tests** for `LatencyTracker`: EWMA over last 50 calls with α=2/(N+1); `HealthState`: 5 consecutive errors → degraded, 10 → unhealthy, 1 success → healthy; `RpcPool`: round-robin reads across healthy endpoints; failover on RpcError; `pinForWrite()` returns lowest-latency healthy; metrics events with `{ endpoint, healthState, latencyMs, errorClass, retryCount }`. Use `msw` to inject failures.

- [ ] **Step 3: Run — fail**

- [ ] **Step 4: Implement** per spec Section 3.2. `RpcPool.call(method, params, opts)` uses `HttpClient` from core, picks an endpoint via the round-robin strategy filtered to healthy, retries up to N on transient errors, demotes endpoint on repeat failure.

- [ ] **Step 5: Re-export.**

- [ ] **Step 6: Run — pass.**

- [ ] **Step 7: Commit.**

---

## Task 14: `solana-connectivity` — Yellowstone gRPC client

**Files:**
- Create: `packages/solana-connectivity/src/proto/yellowstone.proto` (vendored, version-pinned with header comment noting upstream commit hash)
- Create: `packages/solana-connectivity/src/geyser-client.ts` + test
- Create: `packages/solana-connectivity/tests/fixtures/geyser-stream-sample.bin` (Task 14 ships a synthetic sample; live capture is a backlog item)

Add deps: `@grpc/grpc-js: ^1.11.0`, `@grpc/proto-loader: ^0.7.13`.

- [ ] **Step 1: Vendor the proto** — copy from yellowstone-grpc upstream (https://github.com/rpcpool/yellowstone-grpc) `proto/geyser.proto`. Pin commit hash in a header comment.

- [ ] **Step 2: Write tests** for `GeyserClient`:
  - Builds a subscription request from `SubscribeRequest` typed input
  - Connects to a fake gRPC server in tests, receives sample updates, hands them to handler
  - Backpressure: when handler is slow, queue caps at 1000, drops oldest, emits `dropped` event with cumulative count
  - Gap detection: tracks last-seen slot; jump > 1 emits `gap` event with `{ from, to }`
  - On `gap`, optionally calls injected `onGap(from, to)` callback to trigger backfill
  - Checkpoint persisted via injected `CheckpointStore` after every N updates (default N=100); reload on reconnect

- [ ] **Step 3: Run — fail**

- [ ] **Step 4: Implement** using `@grpc/proto-loader` + `@grpc/grpc-js`. Bidirectional stream subscription per Yellowstone protocol. `subscribe(req, handler)` returns `{ close(): void, on(event, cb): void }`.

- [ ] **Step 5: Re-export.**

- [ ] **Step 6: Run — pass with synthetic streams.**

- [ ] **Step 7: Note in advisor backlog** — live Geyser endpoint test is gated on credentials.

- [ ] **Step 8: Commit.**

---

## Task 15: `solana-connectivity` — CheckpointStore (file backend)

**Files:** `packages/solana-connectivity/src/checkpoint-store-file.ts` + test.

- [ ] **Step 1: Write tests** for `FileCheckpointStore({ baseDir })`: `save(key, ckpt)` writes `<baseDir>/<key>.json` atomically (temp file + rename); `load(key)` returns null if missing else parses JSON; concurrent saves to same key serialized.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** with `fs/promises` writeFile + rename for atomicity. In-memory mutex per key.

- [ ] **Step 4: Re-export** + add `CheckpointStore` interface to `index.ts`.

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 16: `solana-connectivity` — RpcHistoricalBackfill

**Files:** `packages/solana-connectivity/src/historical-backfill.ts` + test.

- [ ] **Step 1: Write tests** for: `getSignaturesForAddress(addr, opts)` paginates correctly; `getTransaction(sig)` returns typed result; `getBlocks(from, to)` chunks long ranges into 1000-slot windows; `fetchEventsForProgram(programId, slotRange, decoder)` returns an `AsyncIterable<DecodedEvent>` lazily, surfaces decoding errors via the unknown channel without halting iteration.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** as thin typed wrappers over `RpcPool.call`. Use Solana JSON-RPC method names (`getSignaturesForAddress`, `getTransaction`, `getBlocks`). `fetchEventsForProgram` is an async generator.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 17: `solana-connectivity` — `pnpm diag` CLI

**Files:** `packages/solana-connectivity/src/diag/{cli.ts, probes.ts}` + bin entry in `package.json`.

**Decision (resolved here per advisor note):** `bin` entry lives in `@ap3x/solana-connectivity`'s package.json — `"bin": { "ap3x-solana-diag": "./dist/diag/cli.js" }`. Top-level `pnpm diag` script forwards via `pnpm --filter @ap3x/solana-connectivity diag`.

- [ ] **Step 1: Write tests** for probes:
  - `probeRpc(endpoint)`: returns `{ ok, latencyMs, slot?, errorClass? }`
  - `probeGeyser(endpoint)`: connects, subscribes to slot updates for 5s, returns `{ ok, slotsObserved, latencyP50, errorClass? }`
  - `compareProviders(a, b)`: runs both probes in parallel, reports drift `{ slotDelta, latencyDelta }`
  - CLI mode `--check` exits non-zero on any probe failure.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** probes + CLI. CLI uses `process.argv` parsing (no extra dep). Outputs JSON.

- [ ] **Step 4: Add `diag` script** to package.json: `"diag": "tsx src/diag/cli.ts"` (add `tsx` as a dev dep here so the diag CLI works pre-build).

Actually use `node --import tsx ./src/diag/cli.ts` if avoiding new dep; OR build first then run. Decision: dev dep `tsx` is fine — it's a dev-only tool, doesn't affect the runtime zero-deps rule.

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 18: `solana-tx` — findProgramAddress

**Files:**
- Create: `packages/solana-tx/{package.json, tsconfig.json, tsup.config.ts, vitest.config.ts}` (mirror)
- Create: `packages/solana-tx/src/{index.ts, find-program-address.ts}` + test
- Create: `packages/solana-tx/tests/fixtures/pdas.json` (~20 known PDAs from mainnet programs)

Deps: `@ap3x/solana-core: workspace:*`, `@ap3x/solana-connectivity: workspace:*`, `@noble/ed25519: ^2.1.0`.

- [ ] **Step 1: Scaffold + write tests** for `findProgramAddress(seeds, programId)`. Test against canonical PDAs: SPL ATA derivations, Metaplex metadata PDAs, common bonding-curve PDAs. Verify bump seed correctness.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**: try bumps from 255 down to 0, hash `[...seeds, [bump], programId, "ProgramDerivedAddress"]` with sha256, check off-curve via `@noble/ed25519`'s `utils.isValidPoint(candidate)`; first off-curve point wins.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 19: `solana-tx` — AddressLookupTable read

**Files:** `packages/solana-tx/src/address-lookup-table.ts` + test.

- [ ] **Step 1: Write tests** for `decodeAlt(account: AccountInfo)` returning `{ deactivationSlot, lastExtendedSlot, lastExtendedSlotStartIndex, authority, addresses: PublicKey[] }`. Use 5 captured ALT accounts from mainnet (committed as fixtures). Helper `findInstructionsForKeys(alts, requiredKeys)` returns the ALT(s) covering the most keys.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** using `borsh.Reader` from core. ALT layout: 56-byte header + variable u64 addresses array.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 20: `solana-tx` — PriorityFeeEstimator

**Files:** `packages/solana-tx/src/priority-fee.ts` + test.

**Decision (resolved here per advisor note):** Geyser priority-fee subscription uses Yellowstone's `subscribeTransactions` filter on `vote=false, failed=false` and reads the `meta.fee` from each confirmed transaction. Per-tx microLamports = `(fee - sigCount * 5000) / unitsConsumed`. Window: last 150 slots (rolling). Tier percentiles computed on-demand from the windowed sample.

- [ ] **Step 1: Write tests** for `PriorityFeeEstimator`:
  - Synthetic Geyser stream feeds 1000 transactions with known fees → verify `tier('low')` = p50, `tier('high')` = p90, etc., within tolerance
  - First 30 slots return conservative defaults (e.g., low=1, med=10, high=100, turbo=1000 microLamports)
  - Recomputed every slot
  - Subscribes to Geyser via injected `GeyserClient`; clean shutdown on `close()`

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** per spec Section 3.3 + decision above. Ring buffer of `{ slot, microLamportsPerCu }` entries; percentile computed via sort on demand (small enough sample).

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 21: `solana-tx` — computeBudget stub

**Files:** `packages/solana-tx/src/compute-budget.ts` + test.

- [ ] **Step 1: Write tests** for `simulateAndBudget(rpcPool, tx, payer)`:
  - On success: returns `{ unitsConsumed, unitsLimit: ceil(unitsConsumed * 1.15) }`
  - On simulation failure (non-zero error or RPC failure): returns conservative `{ unitsConsumed: 200_000, unitsLimit: 230_000 }` and emits a metric `{ op: 'compute-budget-fallback', meta: { reason } }`
  - Logs a comment in the metric meta noting this is a PRP-01 stub for PRP-03 to flesh out

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** as thin wrapper over `rpcPool.call('simulateTransaction', [base64Tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }])`. Parse `unitsConsumed` from response.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 22: `solana-tx` — TransactionAssembler v0

**Files:** `packages/solana-tx/src/transaction-assembler.ts` + test.

- [ ] **Step 1: Write tests** for `assemble({ instructions, payer, signers, recentBlockhash, alts? })`:
  - Produces v0 message bytes matching a known-good transaction (capture one with web3.js in a one-off generation script, commit serialized output as fixture, then verify)
  - With ALTs: writable + readonly indexes packed correctly
  - Without ALTs: still produces valid v0 message
  - Throws `Ap3xError` if `payer` not in signers

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** v0 message serialization per Solana docs: header (numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned), accountKeys (compactArray of pubkeys), recentBlockhash (32 bytes), instructions (compactArray of `{ programIdIndex, accounts: compactArray<u8>, data: compactArray<u8> }`), addressTableLookups (compactArray of `{ accountKey, writableIndexes, readonlyIndexes }`). Prefix with version byte `0x80`.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 23: `solana-tx` — JitoBundleBuilder

**Files:** `packages/solana-tx/src/jito-bundle.ts` + test.

- [ ] **Step 1: Write tests** for `JitoBundleBuilder`:
  - `compose(txs)` accepts up to 5 signed transactions; throws if >5
  - `tipInstruction(tipAccount, lamports)` returns a SystemProgram transfer instruction
  - Bundle output is `Bundle = { transactions: Uint8Array[] }` (just the structured payload — submission deferred to PRP-03)

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** per spec.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 24: `solana-spl` — TokenMint + TokenAccount parsers

**Files:**
- Create: `packages/solana-spl/{package.json, ...}` (mirror)
- Create: `packages/solana-spl/src/{index.ts, mint.ts, token-account.ts}` + tests
- Create: `packages/solana-spl/tests/fixtures/spl-accounts-synthetic.json` (10 hand-crafted edge cases)

Deps: `@ap3x/solana-core: workspace:*`, `@ap3x/solana-tx: workspace:*` (PDA helper only — enforce via no-restricted-imports).

- [ ] **Step 1: Scaffold + write tests** for `decodeMint(account)` and `decodeTokenAccount(account)`. Cover: standard SPL v1 mint, mint with revoked authorities (null pubkey), Token-2022 mint program-id, frozen token account, delegated token account, uninitialized account.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** per spec Section 3.4. Layouts:
  - **Mint v1** (82 bytes): mintAuthority (Option<Pubkey>, 36 bytes: 4-byte tag + 32-byte pubkey), supply (u64, 8), decimals (u8, 1), isInitialized (u8, 1), freezeAuthority (Option<Pubkey>, 36).
  - **TokenAccount v1** (165 bytes): mint (32), owner (32), amount (u64, 8), delegate (Option<Pubkey>, 36), state (u8: 0=uninit, 1=init, 2=frozen), isNative (Option<u64>, 12), delegatedAmount (u64, 8), closeAuthority (Option<Pubkey>, 36).
  - Token-2022 detection: program ID `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 25: `solana-spl` — Token-2022 extensions

**Files:** `packages/solana-spl/src/token-2022-extensions.ts` + test.

- [ ] **Step 1: Write tests** for parsing known extensions: `MintCloseAuthority`, `TransferFeeConfig`, `DefaultAccountState`. Plus: synthetic unknown-extension byte stream surfaces in `unknownExtensions: Buffer` field.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** TLV parser — Token-2022 extensions follow a `(type: u16, length: u16, data: bytes)` TLV pattern after the base 165-byte (account) or 82-byte (mint) layout. Decode known types, append unknown types as raw `{ type, data }` records.

- [ ] **Step 4: Update** `decodeMint`/`decodeTokenAccount` to detect Token-2022 program ID and decode extensions.

- [ ] **Step 5: Re-export.**

- [ ] **Step 6: Run — pass.**

- [ ] **Step 7: Commit.**

---

## Task 26: `solana-spl` — ATA + holder queries

**Files:** `packages/solana-spl/src/{ata.ts, holder-queries.ts}` + tests.

- [ ] **Step 1: Write tests** for:
  - `getAssociatedTokenAddress(mint, owner)` matches canonical ATAs (10 vectors from mainnet)
  - `createAssociatedTokenAccountIx(payer, owner, mint)` produces correct instruction bytes
  - `getTokenLargestAccounts(rpcPool, mint, limit?)` calls correct RPC method, returns typed `[{ address, amount }]`
  - `getTokenAccountsByMint(rpcPool, mint, opts?)` paginates, returns typed `[{ pubkey, account: TokenAccount }]`

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** ATA derivation as `findProgramAddress([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)`. Holder queries as typed wrappers over `RpcPool.call`.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 27: `solana-metaplex` — metadata PDA + decoder

**Files:**
- Create: `packages/solana-metaplex/{package.json, ...}` (mirror)
- Create: `packages/solana-metaplex/src/{index.ts, metadata-pda.ts, metadata-decoder.ts}` + tests
- Create: `packages/solana-metaplex/tests/fixtures/metadata-synthetic.json` (10 hand-crafted: v1, v1.3, current; with/without collection; with/without uses)

Deps: `@ap3x/solana-core: workspace:*`, `@ap3x/solana-tx: workspace:*` (PDA only).

- [ ] **Step 1: Scaffold + write tests**:
  - `getMetadataPda(mint)`: matches Metaplex canonical PDA (`["metadata", METADATA_PROGRAM_ID, mint]` as seeds)
  - `decodeMetadata(account)`: handles v1, v1.3, current; surfaces version in result; null-handles missing collection/uses

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** per Metaplex Token Metadata Program spec. Version detection by reading discriminator + length prefixes.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 28: `solana-metaplex` — MetadataResolver + cache

**Files:** `packages/solana-metaplex/src/resolver.ts` + test.

- [ ] **Step 1: Write tests** for `MetadataResolver({ httpClient, cacheSize, fileCacheDir? })`:
  - `resolve(uri)` fetches off-chain JSON, parses tolerantly, returns `{ raw, parsed?, parseErrors? }`
  - Never throws on malformed JSON
  - LRU cache: hits skip network
  - File cache: persists across instances when `fileCacheDir` set
  - Validates expected shape: `{ name, symbol, description?, image?, attributes?[] }` — missing fields surface as `parseErrors`, not exceptions

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** per spec Section 3.5. Hand-rolled validator (no Zod). Use `HttpClient` from core.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 29: `solana-metaplex` — collection helpers + cNFT stub

**Files:** `packages/solana-metaplex/src/{collection.ts, cnft-stub.ts}` + tests.

- [ ] **Step 1: Write tests**:
  - `isCollectionMember(child: Metadata, parent: PublicKey)`: true iff child.collection?.key.equals(parent) and child.collection.verified
  - `verifyCreator(metadata, creator: PublicKey)`: true iff creator in metadata.creators with verified=true
  - `CompressedMetadataReader` interface present; default export `defaultCompressedMetadataReader.read(asset)` throws explicit `Error('cNFT support deferred to magic-eden vertical')`

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** per spec.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 30: `solana-events` — parseLogs + EventDecoderRegistry

**Files:**
- Create: `packages/solana-events/{package.json, ...}` (mirror)
- Create: `packages/solana-events/src/{index.ts, parse-logs.ts, registry.ts}` + tests

Dep: `@ap3x/solana-core: workspace:*`.

- [ ] **Step 1: Scaffold + write tests** for `parseLogs(logs: string[])`:
  - Simple invoke: `["Program <id> invoke [1]", "Program log: hello", "Program <id> success"]` → one chunk with one log
  - Nested CPI 3-deep: invoke[1] → invoke[2] → invoke[3] → success → success → success → tree structure preserved
  - Failed inner invoke: marks chunk as failed
  - `Program data: <base64>` payload decoded into `dataPayloads: Uint8Array[]`
  - Mixed program log + data lines
  - Malformed line surfaces as a structured `LogParseError` not throw

`EventDecoderRegistry`:
- `register(programId, decoder)` accepts decoders
- `decode(transactionLog)`: walks each ProgramLogChunk, calls registered decoder for matching programId, collects events; unknown program IDs surface as `UnknownEventDecode`
- Returns `DecodedEventStream { events: EventUnion[], unknown: UnknownEventDecode[], parseErrors: LogParseError[] }`

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** `parse-logs.ts` as a state machine over the log line array. `registry.ts` as a Map<programIdString, ProgramDecoder>.

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 31: `solana-events` — CPI decoder helpers + UnknownEventDecode

**Files:** `packages/solana-events/src/cpi-decoder.ts` + test.

- [ ] **Step 1: Write tests** for:
  - `walkInvocations(transactionLog)` yields each ProgramLogChunk with depth context
  - `decodeBase64Data(s)` correctly base64-decodes program data
  - `UnknownEventDecode` records carry `{ kind: 'unknown', programId, raw, reason }`

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Re-export.**

- [ ] **Step 5: Run — pass.**

- [ ] **Step 6: Commit.**

---

## Task 32: `examples/solana-watch`

**Files:**
- Create: `examples/solana-watch/{package.json, tsconfig.json, src/main.ts, Dockerfile, scripts/acceptance.sh}`

Deps: all `@ap3x/solana-*` packages as `workspace:*`.

- [ ] **Step 1: Scaffold** package.

- [ ] **Step 2: Write tests** for `main.ts` orchestration logic (parse args, set up Geyser subscription, register decoders, format output). Integration test runs in-memory against the same fake Geyser server harness used in Task 14, asserts JSON output to stdout has the right shape.

- [ ] **Step 3: Run — fail**

- [ ] **Step 4: Implement** `main.ts` (~80–100 LOC):
  - Parse `--program`, `--rpc`, `--geyser`, `--decoder` flags
  - Construct `RpcPool`, `GeyserClient`, `EventDecoderRegistry`
  - Register SPL + Metaplex decoders by default (these decoders are simple wrappers around `decodeMint`/`decodeTokenAccount`/`decodeMetadata` exposed as `ProgramDecoder` instances — colocate as `examples/solana-watch/src/decoders/{spl,metaplex}.ts`)
  - Subscribe to each `--program` ID
  - On each decoded event, print `{slot, programId, kind, latencyMs}` JSON-line to stdout

- [ ] **Step 5: Create `Dockerfile`** for the 1h acceptance run. Node 20 alpine, copies built dist + runs `node dist/main.js`.

- [ ] **Step 6: Create `scripts/acceptance.sh`** — runs `docker run` for 1h, captures stdout, computes p50/p99 latency, exits non-zero on threshold breach.

- [ ] **Step 7: Run — pass.**

- [ ] **Step 8: Commit.**

---

## Task 33: Fixture capture script — SPL accounts

**Files:**
- Create: `tests/helpers/capture/spl-capture.ts` — script that walks recent slots, samples 500 mint + 500 token accounts via `getProgramAccounts`, writes to `tests/fixtures/spl-accounts.json.gz`.
- Add: `tests/fixtures/.gitkeep` (so the dir is tracked even when empty pre-capture).

- [ ] **Step 1: Write the capture script** as a standalone Node entry point under `tests/helpers/capture/`. Reads `RPC_URL` from env. Uses `@ap3x/solana-connectivity` `RpcPool`.

- [ ] **Step 2: Add a `pnpm capture:spl` root script** that runs `node --import tsx tests/helpers/capture/spl-capture.ts`.

- [ ] **Step 3: Document** in `docs/CONTRIBUTING.md`: "When Helius/Triton credentials are available, run `RPC_URL=... pnpm capture:spl` to refresh the SPL fixture. Commit the resulting `.json.gz`."

- [ ] **Step 4: Add a backlog note** to `docs/superpowers/advisor-log-2026-04-19-prp-01.md` flagging gate-2 verification depends on this capture run.

- [ ] **Step 5: Commit.**

---

## Task 34: Fixture capture script — Metaplex accounts

**Files:** `tests/helpers/capture/metaplex-capture.ts` + `pnpm capture:metaplex` script.

- [ ] **Step 1: Write capture script** for Metaplex metadata accounts — sample 200 across v1/v1.3/current layouts.

- [ ] **Step 2: Document** in CONTRIBUTING.md.

- [ ] **Step 3: Backlog note** for gate-2.

- [ ] **Step 4: Commit.**

---

## Task 35: ESLint flat config + boundaries + CI workflows

**Files:**
- Create: `eslint.config.js`
- Create: `.github/workflows/{ci.yml, nightly-diag.yml}`

- [ ] **Step 1: Write `eslint.config.js`** flat-config with `eslint-plugin-boundaries`. Configure element types per package, allow rules per spec Section 2:
  - `core` → []
  - `connectivity` → [core]
  - `tx` → [core, connectivity]
  - `spl` → [core, tx (only `findProgramAddress` named export)]
  - `metaplex` → [core, tx (only `findProgramAddress` named export)]
  - `events` → [core]
  - `vault` → [core]
  - Verticals (future) → [* substrate]

  Use `no-restricted-imports` rule on `solana-spl`/`solana-metaplex` to narrow `tx` to only `findProgramAddress`.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [20.x]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm build
      - run: pnpm test
      - run: pnpm why @solana/web3.js && exit 1 || echo "no forbidden dep"
      - run: pnpm why @solana/spl-token && exit 1 || echo "no forbidden dep"
      - run: pnpm why @metaplex-foundation/js && exit 1 || echo "no forbidden dep"
```

- [ ] **Step 3: Write `.github/workflows/nightly-diag.yml`** — runs `pnpm diag --check` against env-provided RPC + Geyser endpoints. Skipped if secrets not set (use a guard step).

- [ ] **Step 4: Run** `pnpm lint` locally; verify boundary violations would be caught (test by writing a temp file in `solana-vault/src/` that imports from `../../../solana-tx/src/index.ts` — should fail).

- [ ] **Step 5: Run all** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` locally — all pass.

- [ ] **Step 6: Commit.**

---

## Backlog (deferred to optimization loop / arrives with credentials)

Add to `docs/superpowers/advisor-log-2026-04-19-prp-01.md` after Task 35:

- **B1 (gate 1):** Run `examples/solana-watch/scripts/acceptance.sh` for 1h against live mainnet, verify p50<500ms p99<2s. Requires `RPC_URL` + `GEYSER_URL`.
- **B2 (gate 2):** Run `pnpm capture:spl` and `pnpm capture:metaplex`, then run regression suite `pnpm --filter @ap3x/solana-spl test:integration` and `pnpm --filter @ap3x/solana-metaplex test:integration` against captured fixtures. Requires RPC.
- **B3 (gate 3):** Live Geyser gap-recovery test — inject a 10-slot outage by killing the gRPC stream, verify recovery via RPC backfill within 5 slots. Requires Geyser endpoint.
- **B4 (gate 5):** Verify priority-fee p99 against observed landed fees on 10 sample slots. Requires RPC + Geyser.

---

## Self-Review

- **Spec coverage:**
  - 7 packages: core (T2-9), vault (T10-12), connectivity (T13-17), tx (T18-23), spl (T24-26), metaplex (T27-29), events (T30-31). ✓
  - example app: T32. ✓
  - Tooling/CI: T1, T35. ✓
  - Fixture capture: T33-34. ✓
  - All 8 acceptance gates: gates 4/6/7/8 verified by tasks; gates 1/2/3/5 in backlog. ✓
  - Two hedges from advisor surfaced as concrete decisions in T17 (`bin` placement) and T20 (Geyser fee-stream subscription shape). ✓

- **Placeholder scan:** None. All tasks have concrete file paths, tests, and commit cadence. Where code is not inlined verbatim, the spec section reference is explicit.

- **Type consistency:** `RpcPool.call`, `GeyserClient.subscribe`, `EventDecoderRegistry.register/decode`, `WalletHandle.sign/signTransaction`, `findProgramAddress` signatures cross-referenced — consistent.

- **Layering vs. tasks:** core (T2-9) → connectivity/vault (T10-17 in parallel groups) → tx (T18-23) → spl/metaplex (T24-29 in parallel) → events (T30-31) → example (T32) → fixtures (T33-34, can land any time after Task 33's RPC dep is mockable in tests) → CI (T35). Plan task numbers respect this dependency.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-prp-01-solana-substrate.md`. The autonomous-advisor pipeline will dispatch `superpowers:subagent-driven-development` for execution (advisor selects this option per its default rule).

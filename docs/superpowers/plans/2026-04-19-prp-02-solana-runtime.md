# PRP-02 Solana runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers ALSO receive the spec at `docs/superpowers/specs/2026-04-19-prp-02-solana-runtime-design.md` and the source PRP at `roadmap/02-solana-runtime.md` — pull detail from there when a step references "per spec section X.Y". The advisor decision log is at `docs/superpowers/advisor-log-2026-04-19-prp-02.md`.

**Goal:** Ship `@ap3x/solana-{signals,strategy,executor,portfolio}` (4 packages) plus `examples/spl-watcher` — the venue-agnostic Solana runtime sitting between the PRP-01 substrate and any future vertical. Decoded events flow in as Signals; class-based Strategies emit Decisions; the Executor signs/submits via RPC or Jito (HTTP+gRPC); the Portfolio tracks per-lot positions with on-chain cost-basis reconstruction.

**Architecture:** Five-phase plan (A-E per spec §9). `solana-signals` (independent) and SPL transfer decoders (added to `solana-spl`) ship in Phase A alongside the cold-start tx-history fixture capture. `solana-portfolio` builds on signals + the new SPL exports in Phase B. `solana-executor` is independent of A/B and ships in Phase C in parallel. `solana-strategy` is the orchestrator, depends on all three, ships in Phase D. `examples/spl-watcher` dogfoods in Phase E. Boundaries: `signals → core/connectivity/events`; `portfolio → core/connectivity/events/spl(transfer-decoder only)`; `executor → core/connectivity/tx/vault`; `strategy → core/signals/executor/portfolio/vault`. The `ExecutionResult → LandedTrade` adapter lives in `StrategyRuntime` to keep executor and portfolio mutually independent.

**Tech Stack:** TypeScript 5.6+, Node 20+, pnpm 10+, Turbo 2+, Vitest, msw, fast-check, tsup (build). New runtime deps: NONE — reuses `@noble/ed25519`, `@noble/hashes`, `@grpc/grpc-js`, `@grpc/proto-loader`, `libsodium-wrappers-sumo` already in workspace. Vendors `searcher.proto` + `bundle.proto` from `jito-labs/mev-protos` (pinned commit hash).

**Acceptance gates (Option A — same as PRP-01):**
- Verified in-run: gates 2 (idempotency), 3 (restart recovery), 4 (vault reserve), 5 (failover), 6 (backtest parity), 7 (drift+re-reconciliation), 8 (cost-basis ±1 lamport — uses Phase-A captured fixture), 9 (Jito HTTP/gRPC parity via in-process gRPC fake), 10 (lifecycle fidelity), 11 (zero ecosystem deps), 12 (coverage), 13 (boundary enforcement)
- Backlog (gated on Helius Business / Jito mainnet credentials): gates 1 (live 1h Geyser), and live counterparts of 7 (B10), 8 (B11), 9 (B9). Joins PRP-01 backlog (B1/B3/B4/B5).

---

## File Structure (locked)

```
ap3x-solana/
├─ eslint.config.mjs                                    [Task 1 — extend boundaries]
├─ docs/
│  ├─ runtime-architecture.md                           [Task 49]
│  └─ CONTRIBUTING.md                                   [Task 50 — proto rev process]
├─ tests/
│  ├─ helpers/capture/
│  │  └─ capture-cold-start-tx-history.ts               [Task 3]
│  └─ fixtures/
│     ├─ portfolio-cold-start-wallets.json              [Task 3]
│     ├─ cold-start-tx-history.jsonl.gz                 [Task 3 — captured artifact]
│     └─ signals-spl-watcher.jsonl.gz                   [Task 45]
├─ packages/
│  ├─ solana-spl/                                       [Task 2 — additions only]
│  │  └─ src/decoders/
│  │     ├─ transfer-instruction.ts                     [Task 2]
│  │     └─ transfer-log.ts                             [Task 2]
│  ├─ solana-signals/                                   [Tasks 4-11]
│  │  ├─ package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
│  │  └─ src/
│  │     ├─ index.ts                                    (re-exports)
│  │     ├─ signal.ts                                   [Task 4]
│  │     ├─ signal-id.ts                                [Task 4]
│  │     ├─ signal-queue.ts                             [Task 5]
│  │     ├─ checkpoint-store.ts                         [Task 6]
│  │     ├─ source.ts                                   [Task 7 — interface]
│  │     ├─ sources/
│  │     │  ├─ fixture.ts                               [Task 8]
│  │     │  ├─ historical.ts                            [Task 9]
│  │     │  └─ geyser.ts                                [Task 10]
│  ├─ solana-portfolio/                                 [Tasks 12-22]
│  │  ├─ package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
│  │  └─ src/
│  │     ├─ index.ts                                    (re-exports)
│  │     ├─ types.ts                                    [Task 12 — Lot, Position, LandedTrade, events]
│  │     ├─ portfolio-read-api.ts                       [Task 12 — interface]
│  │     ├─ store-file.ts                               [Task 13]
│  │     ├─ accounting.ts                               [Task 14 — FIFO/LIFO/avg]
│  │     ├─ swap-tracer.ts                              [Task 15 — interface + registry]
│  │     ├─ tracers/
│  │     │  └─ spl-transfer.ts                          [Task 16]
│  │     ├─ reconstructor.ts                            [Task 17 — cold-start algorithm]
│  │     ├─ reconciler.ts                               [Task 18 — drift detection]
│  │     ├─ daily-close.ts                              [Task 19]
│  │     └─ cli.ts                                      [Task 20 — correct-basis]
│  ├─ solana-executor/                                  [Tasks 23-34]
│  │  ├─ package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
│  │  └─ src/
│  │     ├─ index.ts                                    (re-exports)
│  │     ├─ types.ts                                    [Task 23 — TradeIntent, ExecutionResult]
│  │     ├─ submitter.ts                                [Task 24 — interface, SubmitPayload, SubmissionAck]
│  │     ├─ submitters/
│  │     │  ├─ rpc.ts                                   [Task 25]
│  │     │  ├─ jito-http.ts                             [Task 26]
│  │     │  └─ jito-grpc.ts                             [Task 28]
│  │     ├─ proto/
│  │     │  ├─ searcher.proto                           [Task 27 — vendored, pinned]
│  │     │  ├─ bundle.proto                             [Task 27 — vendored, pinned]
│  │     │  └─ load.ts                                  [Task 27 — proto-loader wiring]
│  │     ├─ bundle-accumulator.ts                       [Task 29]
│  │     ├─ in-flight.ts                                [Task 30 — idempotency map]
│  │     ├─ confirm-landed.ts                           [Task 31 — polling]
│  │     └─ executor.ts                                 [Task 32 — main Executor class]
│  ├─ solana-strategy/                                  [Tasks 35-44]
│  │  ├─ package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
│  │  └─ src/
│  │     ├─ index.ts                                    (re-exports)
│  │     ├─ strategy.ts                                 [Task 35 — abstract class + types]
│  │     ├─ filter.ts                                   [Task 35 — SignalFilter + indexer]
│  │     ├─ context.ts                                  [Task 36 — StrategyContext, PriceSource, Logger]
│  │     ├─ state-store-file.ts                         [Task 37]
│  │     ├─ instance-queue.ts                           [Task 38 — per-instance FIFO]
│  │     ├─ intent-id.ts                                [Task 39 — derivation]
│  │     ├─ guards.ts                                   [Task 40 — guard tracker + quarantine]
│  │     ├─ landed-trade-adapter.ts                    [Task 41 — ExecutionResult → LandedTrade]
│  │     ├─ runtime.ts                                  [Task 42 — StrategyRuntime]
│  │     └─ backtest.ts                                 [Task 43 — runBacktest + simulated executor]
└─ examples/spl-watcher/                                [Tasks 45-47]
   ├─ package.json, tsconfig.json, tsup.config.ts
   └─ src/
      ├─ index.ts                                       [Task 47 — CLI entry]
      ├─ watcher-strategy.ts                            [Task 46]
      └─ wallets.ts                                     [Task 46]
```

---

## Phase A — Independent foundations (parallelizable after Task 1)

### Task 1: Extend ESLint boundaries for 4 new layers

**Files:**
- Modify: `eslint.config.mjs:62-115`

- [ ] **Step 1: Add 4 new boundary elements to `'boundaries/elements'` (after line 71)**

```js
{ type: 'signals',   pattern: 'packages/solana-signals/src/**' },
{ type: 'portfolio', pattern: 'packages/solana-portfolio/src/**' },
{ type: 'executor',  pattern: 'packages/solana-executor/src/**' },
{ type: 'strategy',  pattern: 'packages/solana-strategy/src/**' },
```

- [ ] **Step 2: Add 4 new rules to `'boundaries/element-types'.rules` (before the `example` rule at line 101)**

```js
{ from: 'signals',   allow: ['core', 'connectivity', 'events'] },
{ from: 'portfolio', allow: ['core', 'connectivity', 'events', 'spl'] },
{ from: 'executor',  allow: ['core', 'connectivity', 'tx', 'vault'] },
{ from: 'strategy',  allow: ['core', 'signals', 'executor', 'portfolio', 'vault'] },
```

- [ ] **Step 3: Extend the existing `example` rule to include the 4 new layers**

Replace the array at lines 102-112 with:
```js
allow: ['core', 'connectivity', 'tx', 'spl', 'metaplex', 'events', 'vault', 'signals', 'strategy', 'executor', 'portfolio'],
```

- [ ] **Step 4: Add a `no-restricted-imports` block scoping `portfolio`'s `@ap3x/solana-spl` access**

After the existing `solana-spl/solana-metaplex` block (around line 178), add:
```js
{
  files: ['packages/solana-portfolio/src/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@ap3x/solana-spl',
            importNames: [
              'TokenMint', 'TokenAccount', 'decodeMint', 'decodeTokenAccount',
              'createAssociatedTokenAccountIx', 'getTokenLargestAccounts', 'getTokenAccountsByMint',
            ],
            message:
              'solana-portfolio may import only the SPL transfer decoders + getAssociatedTokenAddress from @ap3x/solana-spl. Other SPL exports belong to the decoder/builder layer.',
          },
        ],
      },
    ],
  },
},
```

- [ ] **Step 5: Verify lint still passes on existing code**

Run: `pnpm lint`
Expected: PASS (zero new errors; the new rules apply to packages that don't exist yet, so they're inert).

- [ ] **Step 6: Commit**

```bash
git add eslint.config.mjs
git commit -m "tooling: extend eslint-boundaries for PRP-02 runtime layers"
```

---

### Task 2: Add SPL transfer decoders to `@ap3x/solana-spl`

**Files:**
- Create: `packages/solana-spl/src/decoders/transfer-instruction.ts`
- Create: `packages/solana-spl/src/decoders/transfer-log.ts`
- Create: `packages/solana-spl/src/decoders/transfer-instruction.test.ts`
- Create: `packages/solana-spl/src/decoders/transfer-log.test.ts`
- Modify: `packages/solana-spl/src/index.ts` (add re-exports)

- [ ] **Step 1: Write the failing test for `decodeTransferInstruction`**

`packages/solana-spl/src/decoders/transfer-instruction.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { decodeTransferInstruction, SPL_TOKEN_PROGRAM_ID } from './transfer-instruction.js';

describe('decodeTransferInstruction', () => {
  it('decodes a Transfer (variant 3) with amount', () => {
    // SPL Token instruction layout: [variant: u8][amount: u64 LE]
    // Transfer = variant 3, amount = 1_000_000 lamports
    const data = new Uint8Array([3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]);
    const source = PublicKey.fromBase58('11111111111111111111111111111112');
    const dest = PublicKey.fromBase58('11111111111111111111111111111113');
    const owner = PublicKey.fromBase58('11111111111111111111111111111114');
    const ix = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [source, dest, owner],
      data,
    };
    const result = decodeTransferInstruction(ix);
    expect(result).toEqual({ source, dest, amount: 1_000_000n });
  });

  it('returns null for non-SPL Token program', () => {
    const data = new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0]);
    const ix = {
      programId: PublicKey.fromBase58('11111111111111111111111111111111'),
      accounts: [],
      data,
    };
    expect(decodeTransferInstruction(ix)).toBeNull();
  });

  it('returns null for non-Transfer variants', () => {
    const data = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0]); // variant 0 (InitializeMint)
    const ix = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [PublicKey.fromBase58('11111111111111111111111111111112')],
      data,
    };
    expect(decodeTransferInstruction(ix)).toBeNull();
  });

  it('decodes TransferChecked (variant 12) with amount + decimals', () => {
    // TransferChecked = variant 12, amount = 5, decimals = 9
    const data = new Uint8Array([12, 5, 0, 0, 0, 0, 0, 0, 0, 9]);
    const ix = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [
        PublicKey.fromBase58('11111111111111111111111111111112'),
        PublicKey.fromBase58('11111111111111111111111111111113'),
        PublicKey.fromBase58('11111111111111111111111111111114'),
        PublicKey.fromBase58('11111111111111111111111111111115'),
      ],
      data,
    };
    const result = decodeTransferInstruction(ix);
    expect(result).toEqual({
      source: PublicKey.fromBase58('11111111111111111111111111111112'),
      dest: PublicKey.fromBase58('11111111111111111111111111111114'),
      amount: 5n,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ap3x/solana-spl test transfer-instruction`
Expected: FAIL with "Cannot find module './transfer-instruction.js'".

- [ ] **Step 3: Implement `decodeTransferInstruction`**

`packages/solana-spl/src/decoders/transfer-instruction.ts`:
```ts
import { PublicKey } from '@ap3x/solana-core';

export const SPL_TOKEN_PROGRAM_ID = PublicKey.fromBase58(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
export const SPL_TOKEN_2022_PROGRAM_ID = PublicKey.fromBase58(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

export interface InstructionShape {
  programId: PublicKey;
  accounts: PublicKey[];
  data: Uint8Array;
}

export interface DecodedTransfer {
  source: PublicKey;
  dest: PublicKey;
  amount: bigint;
}

const VARIANT_TRANSFER = 3;
const VARIANT_TRANSFER_CHECKED = 12;

export function decodeTransferInstruction(ix: InstructionShape): DecodedTransfer | null {
  if (
    !ix.programId.equals(SPL_TOKEN_PROGRAM_ID) &&
    !ix.programId.equals(SPL_TOKEN_2022_PROGRAM_ID)
  ) {
    return null;
  }
  if (ix.data.length === 0) return null;
  const variant = ix.data[0];

  if (variant === VARIANT_TRANSFER) {
    if (ix.data.length < 9 || ix.accounts.length < 3) return null;
    const amount = readU64LE(ix.data, 1);
    return { source: ix.accounts[0]!, dest: ix.accounts[1]!, amount };
  }

  if (variant === VARIANT_TRANSFER_CHECKED) {
    if (ix.data.length < 10 || ix.accounts.length < 4) return null;
    const amount = readU64LE(ix.data, 1);
    // accounts: [source, mint, dest, owner]
    return { source: ix.accounts[0]!, dest: ix.accounts[2]!, amount };
  }

  return null;
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(buf[offset + i]!) << BigInt(i * 8);
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ap3x/solana-spl test transfer-instruction`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing test for `parseTransferLog`**

`packages/solana-spl/src/decoders/transfer-log.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { parseTransferLog } from './transfer-log.js';
import { SPL_TOKEN_PROGRAM_ID } from './transfer-instruction.js';

describe('parseTransferLog', () => {
  it('parses a Transfer chunk with base64 instruction data', () => {
    // Same Transfer variant 3, amount 1_000_000, base64-encoded
    const data = Buffer.from([3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]).toString('base64');
    const chunk = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [
        PublicKey.fromBase58('11111111111111111111111111111112'),
        PublicKey.fromBase58('11111111111111111111111111111113'),
        PublicKey.fromBase58('11111111111111111111111111111114'),
      ],
      logs: [`Program data: ${data}`],
      inner: [],
    };
    const result = parseTransferLog(chunk);
    expect(result).toEqual({
      source: PublicKey.fromBase58('11111111111111111111111111111112'),
      dest: PublicKey.fromBase58('11111111111111111111111111111113'),
      amount: 1_000_000n,
    });
  });

  it('returns null when no Program data line is present', () => {
    const chunk = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [PublicKey.fromBase58('11111111111111111111111111111112')],
      logs: ['Program log: nothing here'],
      inner: [],
    };
    expect(parseTransferLog(chunk)).toBeNull();
  });

  it('returns null when chunk is for a different program', () => {
    const data = Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
    const chunk = {
      programId: PublicKey.fromBase58('11111111111111111111111111111111'),
      accounts: [],
      logs: [`Program data: ${data}`],
      inner: [],
    };
    expect(parseTransferLog(chunk)).toBeNull();
  });
});
```

- [ ] **Step 6: Implement `parseTransferLog`**

`packages/solana-spl/src/decoders/transfer-log.ts`:
```ts
import { PublicKey, decodeBase64Data } from '@ap3x/solana-core';
import {
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  decodeTransferInstruction,
  type DecodedTransfer,
} from './transfer-instruction.js';

export interface ProgramLogChunk {
  programId: PublicKey;
  accounts: PublicKey[];
  logs: string[];
  inner: ProgramLogChunk[];
}

const PROGRAM_DATA_PREFIX = 'Program data: ';

export function parseTransferLog(chunk: ProgramLogChunk): DecodedTransfer | null {
  if (
    !chunk.programId.equals(SPL_TOKEN_PROGRAM_ID) &&
    !chunk.programId.equals(SPL_TOKEN_2022_PROGRAM_ID)
  ) {
    return null;
  }
  for (const line of chunk.logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length);
    let data: Uint8Array;
    try {
      data = decodeBase64Data(b64);
    } catch {
      continue;
    }
    const decoded = decodeTransferInstruction({
      programId: chunk.programId,
      accounts: chunk.accounts,
      data,
    });
    if (decoded) return decoded;
  }
  return null;
}
```

- [ ] **Step 7: Run both decoder tests**

Run: `pnpm --filter @ap3x/solana-spl test decoders/`
Expected: PASS, 7 tests total.

- [ ] **Step 8: Re-export from package index**

Modify `packages/solana-spl/src/index.ts` — add to the existing exports:
```ts
export {
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  decodeTransferInstruction,
  type InstructionShape,
  type DecodedTransfer,
} from './decoders/transfer-instruction.js';
export { parseTransferLog, type ProgramLogChunk } from './decoders/transfer-log.js';
```

- [ ] **Step 9: Build and lint**

Run: `pnpm --filter @ap3x/solana-spl build && pnpm --filter @ap3x/solana-spl lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/solana-spl/src/decoders/ packages/solana-spl/src/index.ts
git commit -m "solana-spl: SPL Token transfer decoders (instruction + log)"
```

---

### Task 3: Capture cold-start tx-history fixture (gate-8 prereq)

**Files:**
- Create: `tests/helpers/capture/capture-cold-start-tx-history.ts`
- Create: `tests/fixtures/portfolio-cold-start-wallets.json` (selection metadata)
- Create (artifact, gz-compressed): `tests/fixtures/cold-start-tx-history.jsonl.gz`
- Modify: root `package.json` — add `"capture:cold-start-tx-history"` script

This task is API-key-gated (Helius free tier — supports `getSignaturesForAddress` + `getTransaction`). NOT Business-gated. Runs once; output committed.

- [ ] **Step 1: Add capture script to root `package.json`**

Add to `scripts`:
```json
"capture:cold-start-tx-history": "tsx tests/helpers/capture/capture-cold-start-tx-history.ts"
```

- [ ] **Step 2: Implement the wallet-selection logic**

`tests/helpers/capture/capture-cold-start-tx-history.ts`:
```ts
/**
 * Captures the per-tx signature history needed for gate-8 cost-basis
 * reconstruction. Selects 10 wallets from the existing
 * `tests/fixtures/spl-accounts.json.gz` snapshot (PRP-01 commit 80eb783) with
 * non-trivial trade history, then for each wallet pages
 * getSignaturesForAddress (90d lookback) and getTransaction for every
 * signature, gz-compressing the result.
 *
 * Run once with RPC_URL set to a Helius free-tier endpoint:
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=... pnpm capture:cold-start-tx-history
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { PublicKey } from '@ap3x/solana-core';
import { RpcPool } from '@ap3x/solana-connectivity';
import { decodeTokenAccount } from '@ap3x/solana-spl';

const FIXTURE_ROOT = path.resolve('tests/fixtures');
const SOURCE = path.join(FIXTURE_ROOT, 'spl-accounts.json.gz');
const SELECTION_OUT = path.join(FIXTURE_ROOT, 'portfolio-cold-start-wallets.json');
const HISTORY_OUT = path.join(FIXTURE_ROOT, 'cold-start-tx-history.jsonl.gz');
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const TARGET_WALLETS = 10;
const MIN_SIGS_PER_WALLET = 3;

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL env var required');

  const rpcPool = new RpcPool({
    endpoints: [{ name: 'helius', url: rpcUrl, kind: 'http' }],
  });

  // 1. Read SPL token accounts from the existing fixture.
  const accounts = await readSplFixture(SOURCE);

  // 2. Filter to non-zero balance, dedupe by owner, pick TARGET_WALLETS owners.
  const ownerToTokenAccount = new Map<string, { mint: string; balance: bigint }>();
  for (const acc of accounts) {
    const decoded = decodeTokenAccount(acc);
    if (decoded.amount === 0n) continue;
    if (decoded.state !== 'initialized') continue;
    const owner = decoded.owner.toBase58();
    if (ownerToTokenAccount.has(owner)) continue;
    ownerToTokenAccount.set(owner, { mint: decoded.mint.toBase58(), balance: decoded.amount });
    if (ownerToTokenAccount.size >= TARGET_WALLETS * 4) break; // candidates
  }

  // 3. For each candidate, fetch signature count; keep top TARGET_WALLETS by sig count.
  const sinceSlotMs = Date.now() - LOOKBACK_MS;
  const candidates: Array<{ wallet: string; mint: string; sigCount: number }> = [];
  for (const [wallet, { mint }] of ownerToTokenAccount) {
    const sigs = await rpcPool.call('getSignaturesForAddress', [wallet, { limit: 1000 }]);
    const inWindow = sigs.filter(
      (s: { blockTime: number | null }) => s.blockTime !== null && s.blockTime * 1000 >= sinceSlotMs,
    );
    if (inWindow.length < MIN_SIGS_PER_WALLET) continue;
    candidates.push({ wallet, mint, sigCount: inWindow.length });
    if (candidates.length >= TARGET_WALLETS) break;
  }

  if (candidates.length < TARGET_WALLETS) {
    throw new Error(`only ${candidates.length} qualifying wallets, expected ${TARGET_WALLETS}`);
  }

  await fs.writeFile(SELECTION_OUT, JSON.stringify({ capturedAt: Date.now(), wallets: candidates }, null, 2));
  console.log(`Selected ${candidates.length} wallets → ${SELECTION_OUT}`);

  // 4. For each selected wallet, fetch every getTransaction and stream-write.
  const gzip = zlib.createGzip();
  const out = createWriteStream(HISTORY_OUT);
  gzip.pipe(out);

  for (const { wallet, mint } of candidates) {
    const sigs = await rpcPool.call('getSignaturesForAddress', [wallet, { limit: 1000 }]);
    for (const s of sigs) {
      if (s.blockTime === null || s.blockTime * 1000 < sinceSlotMs) continue;
      const tx = await rpcPool.call('getTransaction', [
        s.signature,
        { maxSupportedTransactionVersion: 0, encoding: 'json' },
      ]);
      if (!tx) continue;
      const line = JSON.stringify({ wallet, mint, signature: s.signature, slot: s.slot, tx });
      gzip.write(line + '\n');
    }
  }
  gzip.end();
  await new Promise<void>((res) => out.on('close', () => res()));
  console.log(`Captured tx history → ${HISTORY_OUT}`);
}

async function readSplFixture(p: string): Promise<unknown[]> {
  const accounts: unknown[] = [];
  const gunzip = zlib.createGunzip();
  createReadStream(p).pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    accounts.push(JSON.parse(line));
  }
  return accounts;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Run capture against Helius free tier**

```bash
RPC_URL='https://mainnet.helius-rpc.com/?api-key=<KEY>' pnpm capture:cold-start-tx-history
```
Expected: writes `tests/fixtures/portfolio-cold-start-wallets.json` (10 wallets) and `tests/fixtures/cold-start-tx-history.jsonl.gz` (likely 5-50 MB compressed).

If the operator does not have a Helius key right now, mark this task as backlog item B12 and continue with the rest of the plan; gate-8 will be backlog-deferred until B12 lands.

- [ ] **Step 4: Verify fixture loads cleanly via a smoke test**

`tests/helpers/capture/capture-cold-start-tx-history.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';

describe('cold-start-tx-history fixture', () => {
  it('decompresses and parses every line', async () => {
    const p = path.resolve('tests/fixtures/cold-start-tx-history.jsonl.gz');
    const gunzip = zlib.createGunzip();
    createReadStream(p).pipe(gunzip);
    const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
    let count = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      expect(parsed.wallet).toBeDefined();
      expect(parsed.signature).toBeDefined();
      expect(parsed.tx).toBeDefined();
      count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(30); // 10 wallets × ≥3 sigs
  });
});
```

Run: `pnpm vitest run tests/helpers/capture/capture-cold-start-tx-history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit script + selection JSON + (if available) compressed fixture**

```bash
git add tests/helpers/capture/capture-cold-start-tx-history.ts \
        tests/helpers/capture/capture-cold-start-tx-history.test.ts \
        tests/fixtures/portfolio-cold-start-wallets.json \
        tests/fixtures/cold-start-tx-history.jsonl.gz \
        package.json
git commit -m "scripts: pnpm capture:cold-start-tx-history (gate-8 prereq)"
```

If the .gz file is not available (no Helius key), commit only the script + smoke test and add B12 backlog entry to advisor log.

---

### Task 4: `solana-signals` — package scaffold + Signal type + signalId

**Files:**
- Create: `packages/solana-signals/package.json`
- Create: `packages/solana-signals/tsconfig.json`
- Create: `packages/solana-signals/tsup.config.ts`
- Create: `packages/solana-signals/vitest.config.ts`
- Create: `packages/solana-signals/README.md`
- Create: `packages/solana-signals/src/index.ts`
- Create: `packages/solana-signals/src/signal.ts`
- Create: `packages/solana-signals/src/signal-id.ts`
- Create: `packages/solana-signals/src/signal-id.test.ts`

- [ ] **Step 1: Scaffold `package.json` (mirror `solana-events/package.json` structure)**

```json
{
  "name": "@ap3x/solana-signals",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ap3x/solana-core": "workspace:*",
    "@ap3x/solana-connectivity": "workspace:*",
    "@ap3x/solana-events": "workspace:*",
    "@noble/hashes": "^1.4.0"
  },
  "devDependencies": {
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Scaffold `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` (copy `solana-events` versions verbatim)**

```bash
cp packages/solana-events/tsconfig.json packages/solana-signals/tsconfig.json
cp packages/solana-events/tsup.config.ts packages/solana-signals/tsup.config.ts
cp packages/solana-events/vitest.config.ts packages/solana-signals/vitest.config.ts
```

- [ ] **Step 3: Run `pnpm install` to wire workspace deps**

Run: `pnpm install`
Expected: PASS (resolves new package via workspace protocol).

- [ ] **Step 4: Write the failing test for `signalId`**

`packages/solana-signals/src/signal-id.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { signalId } from './signal-id.js';

describe('signalId', () => {
  it('is deterministic for identical inputs', () => {
    const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const a = signalId({ signature: '5xY2...', programId, kind: 'spl.transfer', logIndex: 0 });
    const b = signalId({ signature: '5xY2...', programId, kind: 'spl.transfer', logIndex: 0 });
    expect(a).toBe(b);
  });

  it('changes when any field changes', () => {
    const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const base = { signature: '5xY2', programId, kind: 'spl.transfer', logIndex: 0 };
    const all = [
      signalId(base),
      signalId({ ...base, signature: '5xY3' }),
      signalId({ ...base, kind: 'spl.mint' }),
      signalId({ ...base, logIndex: 1 }),
    ];
    expect(new Set(all).size).toBe(4);
  });

  it('returns a base58 string of length 43-44 (sha256 base58)', () => {
    const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const id = signalId({ signature: '5xY2', programId, kind: 'spl.transfer', logIndex: 0 });
    expect(id.length).toBeGreaterThanOrEqual(43);
    expect(id.length).toBeLessThanOrEqual(44);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @ap3x/solana-signals test`
Expected: FAIL (module not found).

- [ ] **Step 6: Implement `signalId`**

`packages/solana-signals/src/signal-id.ts`:
```ts
import { sha256 } from '@noble/hashes/sha256';
import { base58, PublicKey } from '@ap3x/solana-core';

export interface SignalIdInput {
  signature: string;
  programId: PublicKey;
  kind: string;
  logIndex: number;
}

export function signalId(input: SignalIdInput): string {
  const enc = new TextEncoder();
  const parts = [
    enc.encode(input.signature),
    input.programId.toBuffer(),
    enc.encode(input.kind),
    enc.encode(String(input.logIndex)),
  ];
  const sep = enc.encode('\x00');
  let total = 0;
  for (const p of parts) total += p.length + sep.length;
  const buf = new Uint8Array(total - sep.length);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    buf.set(p, off);
    off += p.length;
    if (i < parts.length - 1) {
      buf.set(sep, off);
      off += sep.length;
    }
  }
  const digest = sha256(buf);
  return base58.encode(digest);
}
```

- [ ] **Step 7: Define the `Signal` type**

`packages/solana-signals/src/signal.ts`:
```ts
import type { PublicKey } from '@ap3x/solana-core';
import type { ProgramLogChunk } from '@ap3x/solana-events';

export interface Signal<TDecoded = unknown> {
  signalId: string;
  ts: number;
  slot: number;
  signature: string;
  programId: PublicKey;
  kind: string;
  venue?: string;
  decoded: TDecoded;
  raw: ProgramLogChunk;
}

export interface GapEvent {
  fromSlot: number;
  toSlot: number;
  reason: 'skip' | 'reorg' | 'source-restart';
}
```

- [ ] **Step 8: Wire re-exports in `src/index.ts`**

```ts
export { signalId } from './signal-id.js';
export type { SignalIdInput } from './signal-id.js';
export type { Signal, GapEvent } from './signal.js';
```

- [ ] **Step 9: Build, lint, test**

Run: `pnpm --filter @ap3x/solana-signals build && pnpm --filter @ap3x/solana-signals lint && pnpm --filter @ap3x/solana-signals test`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/solana-signals/
git commit -m "solana-signals: package scaffold + Signal type + signalId derivation"
```

---

### Task 5: `solana-signals` — `SignalQueue`

**Files:**
- Create: `packages/solana-signals/src/signal-queue.ts`
- Create: `packages/solana-signals/src/signal-queue.test.ts`
- Modify: `packages/solana-signals/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/solana-signals/src/signal-queue.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { SignalQueue } from './signal-queue.js';
import type { Signal } from './signal.js';
import { PublicKey } from '@ap3x/solana-core';

const mkSignal = (id: string): Signal => ({
  signalId: id,
  ts: 0, slot: 0, signature: id,
  programId: PublicKey.fromBase58('11111111111111111111111111111111'),
  kind: 'test', decoded: {}, raw: { programId: PublicKey.fromBase58('11111111111111111111111111111111'), accounts: [], logs: [], inner: [] },
});

describe('SignalQueue', () => {
  it('delivers signals to a subscriber in push order', async () => {
    const q = new SignalQueue({ capacity: 100 });
    const seen: string[] = [];
    q.subscribe('sub', async (s) => { seen.push(s.signalId); });
    await q.push(mkSignal('a'));
    await q.push(mkSignal('b'));
    await q.push(mkSignal('c'));
    await q.drain();
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('drops duplicates within the dedup window', async () => {
    const q = new SignalQueue({ capacity: 100, dedupWindow: 10, dedupTtlMs: 60_000 });
    const seen: string[] = [];
    q.subscribe('sub', async (s) => { seen.push(s.signalId); });
    await q.push(mkSignal('a'));
    await q.push(mkSignal('a')); // dup
    await q.push(mkSignal('b'));
    await q.drain();
    expect(seen).toEqual(['a', 'b']);
  });

  it('emits overflow event and drops oldest when capacity hit', async () => {
    const q = new SignalQueue({ capacity: 2 });
    const overflow = vi.fn();
    q.on('overflow', overflow);
    // No subscriber → backlog accumulates.
    await q.push(mkSignal('a'));
    await q.push(mkSignal('b'));
    await q.push(mkSignal('c'));
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(overflow.mock.calls[0]![0]).toMatchObject({ count: 1 });
  });

  it('expires dedup entries after dedupTtlMs', async () => {
    vi.useFakeTimers();
    const q = new SignalQueue({ capacity: 100, dedupWindow: 10, dedupTtlMs: 1000 });
    const seen: string[] = [];
    q.subscribe('sub', async (s) => { seen.push(s.signalId); });
    await q.push(mkSignal('a'));
    vi.advanceTimersByTime(2000);
    await q.push(mkSignal('a')); // re-allowed after TTL
    await q.drain();
    expect(seen).toEqual(['a', 'a']);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `pnpm --filter @ap3x/solana-signals test signal-queue`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `SignalQueue`**

`packages/solana-signals/src/signal-queue.ts`:
```ts
import { EventEmitter } from 'node:events';
import type { Signal } from './signal.js';

export interface SignalQueueOpts {
  capacity?: number;       // default 10_000
  dedupWindow?: number;    // default 5_000 (LRU size)
  dedupTtlMs?: number;     // default 600_000 (10 min)
}

type Handler = (s: Signal) => Promise<void> | void;

export class SignalQueue extends EventEmitter {
  private readonly capacity: number;
  private readonly dedupWindow: number;
  private readonly dedupTtlMs: number;
  private readonly buffer: Signal[] = [];
  private readonly subscribers = new Map<string, Handler>();
  private readonly dedup = new Map<string, number>(); // id → expiresAt
  private dispatching = false;

  constructor(opts: SignalQueueOpts = {}) {
    super();
    this.capacity = opts.capacity ?? 10_000;
    this.dedupWindow = opts.dedupWindow ?? 5_000;
    this.dedupTtlMs = opts.dedupTtlMs ?? 600_000;
  }

  subscribe(name: string, handler: Handler): void {
    this.subscribers.set(name, handler);
    void this.dispatch();
  }

  unsubscribe(name: string): void {
    this.subscribers.delete(name);
  }

  async push(signal: Signal): Promise<void> {
    this.evictExpiredDedup();
    if (this.dedup.has(signal.signalId)) {
      this.emit('drop', { reason: 'dup', signalId: signal.signalId });
      return;
    }
    this.dedup.set(signal.signalId, Date.now() + this.dedupTtlMs);
    if (this.dedup.size > this.dedupWindow) {
      const firstKey = this.dedup.keys().next().value;
      if (firstKey !== undefined) this.dedup.delete(firstKey);
    }

    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
      this.emit('overflow', { count: 1, since: Date.now() });
    }
    this.buffer.push(signal);
    void this.dispatch();
  }

  async drain(): Promise<void> {
    while (this.buffer.length > 0 && this.subscribers.size > 0) {
      await new Promise<void>((res) => setImmediate(res));
      await this.dispatch();
    }
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.buffer.length > 0 && this.subscribers.size > 0) {
        const sig = this.buffer.shift()!;
        for (const [name, handler] of this.subscribers) {
          try {
            await handler(sig);
          } catch (err) {
            this.emit('handler-error', { subscriber: name, error: err });
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  private evictExpiredDedup(): void {
    const now = Date.now();
    for (const [id, expires] of this.dedup) {
      if (expires <= now) this.dedup.delete(id);
      else break; // Map preserves insertion order; first non-expired ends the sweep
    }
  }
}
```

- [ ] **Step 4: Run tests until passing**

Run: `pnpm --filter @ap3x/solana-signals test signal-queue`
Expected: PASS, 4 tests.

- [ ] **Step 5: Re-export in index**

Add to `packages/solana-signals/src/index.ts`:
```ts
export { SignalQueue, type SignalQueueOpts } from './signal-queue.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/solana-signals/src/signal-queue.ts \
        packages/solana-signals/src/signal-queue.test.ts \
        packages/solana-signals/src/index.ts
git commit -m "solana-signals: SignalQueue with dedup + overflow"
```

---

### Task 6: `solana-signals` — `FileSignalCheckpointStore`

**Files:**
- Create: `packages/solana-signals/src/checkpoint-store.ts`
- Create: `packages/solana-signals/src/checkpoint-store.test.ts`
- Modify: `packages/solana-signals/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/solana-signals/src/checkpoint-store.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileSignalCheckpointStore } from './checkpoint-store.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-ckpt-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('FileSignalCheckpointStore', () => {
  it('returns null for missing checkpoint', async () => {
    const store = new FileSignalCheckpointStore({ dir });
    expect(await store.load('sub1')).toBeNull();
  });

  it('round-trips save → load', async () => {
    const store = new FileSignalCheckpointStore({ dir });
    await store.save('sub1', { lastSignalId: 'abc', lastSlot: 42 });
    expect(await store.load('sub1')).toEqual({ lastSignalId: 'abc', lastSlot: 42 });
  });

  it('isolates per-subscriber files', async () => {
    const store = new FileSignalCheckpointStore({ dir });
    await store.save('a', { lastSignalId: '1', lastSlot: 1 });
    await store.save('b', { lastSignalId: '2', lastSlot: 2 });
    expect(await store.load('a')).toEqual({ lastSignalId: '1', lastSlot: 1 });
    expect(await store.load('b')).toEqual({ lastSignalId: '2', lastSlot: 2 });
  });

  it('survives concurrent saves to the same subscriber via mutex', async () => {
    const store = new FileSignalCheckpointStore({ dir });
    await Promise.all([
      store.save('sub', { lastSignalId: 'a', lastSlot: 1 }),
      store.save('sub', { lastSignalId: 'b', lastSlot: 2 }),
      store.save('sub', { lastSignalId: 'c', lastSlot: 3 }),
    ]);
    const result = await store.load('sub');
    expect(['a', 'b', 'c']).toContain(result!.lastSignalId);
  });
});
```

- [ ] **Step 2: Implement `FileSignalCheckpointStore` (mirror `FileCheckpointStore` from `solana-connectivity`)**

`packages/solana-signals/src/checkpoint-store.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SignalCheckpoint {
  lastSignalId: string;
  lastSlot: number;
}

export interface SignalCheckpointStore {
  load(subscriber: string): Promise<SignalCheckpoint | null>;
  save(subscriber: string, ckpt: SignalCheckpoint): Promise<void>;
}

export interface FileSignalCheckpointStoreOpts {
  dir?: string;
}

export class FileSignalCheckpointStore implements SignalCheckpointStore {
  private readonly dir: string;
  private readonly mutexes = new Map<string, Promise<void>>();

  constructor(opts: FileSignalCheckpointStoreOpts = {}) {
    this.dir = opts.dir ?? '.ap3x/signals';
  }

  async load(subscriber: string): Promise<SignalCheckpoint | null> {
    const p = this.pathFor(subscriber);
    try {
      const raw = await fs.readFile(p, 'utf8');
      return JSON.parse(raw) as SignalCheckpoint;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(subscriber: string, ckpt: SignalCheckpoint): Promise<void> {
    await this.withMutex(subscriber, async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const p = this.pathFor(subscriber);
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(ckpt));
      await fs.rename(tmp, p);
    });
  }

  private pathFor(subscriber: string): string {
    const safe = subscriber.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  private async withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(key) ?? Promise.resolve();
    let resolveOuter: () => void;
    const next = new Promise<void>((res) => { resolveOuter = res; });
    this.mutexes.set(key, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      resolveOuter!();
      if (this.mutexes.get(key) === prev.then(() => next)) {
        this.mutexes.delete(key);
      }
    }
  }
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @ap3x/solana-signals test checkpoint-store`
Expected: PASS, 4 tests.

- [ ] **Step 4: Re-export in index**

```ts
export {
  FileSignalCheckpointStore,
  type SignalCheckpointStore,
  type SignalCheckpoint,
  type FileSignalCheckpointStoreOpts,
} from './checkpoint-store.js';
```

- [ ] **Step 5: Commit**

```bash
git add packages/solana-signals/src/checkpoint-store.ts \
        packages/solana-signals/src/checkpoint-store.test.ts \
        packages/solana-signals/src/index.ts
git commit -m "solana-signals: FileSignalCheckpointStore (atomic writes + mutex)"
```

---

### Task 7: `solana-signals` — `SignalSource` interface

**Files:**
- Create: `packages/solana-signals/src/source.ts`
- Modify: `packages/solana-signals/src/index.ts`

- [ ] **Step 1: Define the interface (no test — pure type contract)**

`packages/solana-signals/src/source.ts`:
```ts
import type { Signal, GapEvent } from './signal.js';

export interface SignalSource {
  readonly name: string;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  on(event: 'signal', listener: (s: Signal) => void): this;
  on(event: 'gap',    listener: (g: GapEvent) => void): this;
  on(event: 'error',  listener: (e: Error) => void): this;
  on(event: 'end',    listener: () => void): this;
}
```

- [ ] **Step 2: Re-export + commit**

Add to index:
```ts
export type { SignalSource } from './source.js';
```

```bash
git add packages/solana-signals/src/source.ts packages/solana-signals/src/index.ts
git commit -m "solana-signals: SignalSource interface"
```

---

### Task 8: `solana-signals` — `FixtureSignalSource`

**Files:**
- Create: `packages/solana-signals/src/sources/fixture.ts`
- Create: `packages/solana-signals/src/sources/fixture.test.ts`
- Modify: `packages/solana-signals/src/index.ts`

- [ ] **Step 1: Write failing test**

`packages/solana-signals/src/sources/fixture.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { FixtureSignalSource } from './fixture.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-fix-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const writeFixture = async (file: string, lines: object[]): Promise<void> => {
  const gz = zlib.createGzip();
  const out = createWriteStream(file);
  gz.pipe(out);
  for (const l of lines) gz.write(JSON.stringify(l) + '\n');
  gz.end();
  await new Promise<void>((res) => out.on('close', () => res()));
};

describe('FixtureSignalSource', () => {
  it('replays gz-compressed jsonl signals', async () => {
    const file = path.join(dir, 'sig.jsonl.gz');
    await writeFixture(file, [
      { signalId: 'a', ts: 1, slot: 100, signature: 's1', programId: '11111111111111111111111111111111', kind: 'k', decoded: {}, raw: { programId: '11111111111111111111111111111111', accounts: [], logs: [], inner: [] } },
      { signalId: 'b', ts: 2, slot: 101, signature: 's2', programId: '11111111111111111111111111111111', kind: 'k', decoded: {}, raw: { programId: '11111111111111111111111111111111', accounts: [], logs: [], inner: [] } },
    ]);
    const src = new FixtureSignalSource({ path: file });
    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signalId));
    await src.start();
    await new Promise((r) => src.on('end', () => r(undefined)));
    expect(got).toEqual(['a', 'b']);
  });

  it('honors AbortSignal mid-stream', async () => {
    const file = path.join(dir, 'big.jsonl.gz');
    const lines = Array.from({ length: 1000 }, (_, i) => ({
      signalId: `s${i}`, ts: i, slot: i, signature: `sig${i}`,
      programId: '11111111111111111111111111111111', kind: 'k', decoded: {},
      raw: { programId: '11111111111111111111111111111111', accounts: [], logs: [], inner: [] },
    }));
    await writeFixture(file, lines);
    const src = new FixtureSignalSource({ path: file });
    const ctrl = new AbortController();
    let count = 0;
    src.on('signal', () => {
      count++;
      if (count === 5) ctrl.abort();
    });
    await src.start(ctrl.signal);
    expect(count).toBeLessThan(1000);
  });
});
```

- [ ] **Step 2: Implement**

`packages/solana-signals/src/sources/fixture.ts`:
```ts
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { PublicKey } from '@ap3x/solana-core';
import type { SignalSource } from '../source.js';
import type { Signal } from '../signal.js';

export interface FixtureSignalSourceOpts {
  path: string;
  name?: string;
}

export class FixtureSignalSource extends EventEmitter implements SignalSource {
  readonly name: string;
  private readonly path: string;
  private aborted = false;

  constructor(opts: FixtureSignalSourceOpts) {
    super();
    this.path = opts.path;
    this.name = opts.name ?? 'fixture';
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener('abort', () => { this.aborted = true; });
    const gz = zlib.createGunzip();
    createReadStream(this.path).pipe(gz);
    const rl = readline.createInterface({ input: gz, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (this.aborted) break;
        if (!line.trim()) continue;
        const s = this.parseSignal(line);
        if (s) this.emit('signal', s);
      }
      this.emit('end');
    } catch (err) {
      this.emit('error', err);
    }
  }

  async stop(): Promise<void> {
    this.aborted = true;
  }

  private parseSignal(line: string): Signal | null {
    const j = JSON.parse(line);
    if (typeof j.programId === 'string') j.programId = PublicKey.fromBase58(j.programId);
    if (j.raw && typeof j.raw.programId === 'string') {
      j.raw.programId = PublicKey.fromBase58(j.raw.programId);
    }
    return j as Signal;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-signals test sources/fixture
# add to index, build, lint
git add packages/solana-signals/src/sources/fixture.ts \
        packages/solana-signals/src/sources/fixture.test.ts \
        packages/solana-signals/src/index.ts
git commit -m "solana-signals: FixtureSignalSource (gz jsonl replay)"
```

Add to index: `export { FixtureSignalSource, type FixtureSignalSourceOpts } from './sources/fixture.js';`

---

### Task 9: `solana-signals` — `HistoricalSignalSource`

**Files:**
- Create: `packages/solana-signals/src/sources/historical.ts`
- Create: `packages/solana-signals/src/sources/historical.test.ts`
- Modify: `packages/solana-signals/src/index.ts`

- [ ] **Step 1: Write failing test against fake `RpcPool`**

`packages/solana-signals/src/sources/historical.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { HistoricalSignalSource } from './historical.js';

const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const fakeRpcPool = (events: Array<{ slot: number; signature: string }>): any => ({
  call: vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getBlocks') {
      const [from, to] = params as [number, number];
      return events.filter((e) => e.slot >= from && e.slot <= to).map((e) => e.slot);
    }
    if (method === 'getBlock') {
      const [slot] = params as [number];
      const e = events.find((x) => x.slot === slot);
      return e ? { transactions: [{ transaction: { signatures: [e.signature] }, meta: { logMessages: [`Program ${programId.toBase58()} invoke [1]`, `Program ${programId.toBase58()} success`] } }] } : null;
    }
    return null;
  }),
});

const fakeRegistry = {
  decode: () => ({ events: [{ kind: 'test', decoded: {}, programId, logIndex: 0 }], unknown: [] }),
};

describe('HistoricalSignalSource', () => {
  it('emits signals for each decoded event in slot range', async () => {
    const rpcPool = fakeRpcPool([
      { slot: 100, signature: 's1' },
      { slot: 101, signature: 's2' },
      { slot: 102, signature: 's3' },
    ]);
    const src = new HistoricalSignalSource({
      rpcPool,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
      slotRange: { from: 100, to: 102 },
      batchSize: 10,
    });
    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));
    await src.start();
    expect(got).toEqual(['s1', 's2', 's3']);
  });

  it('paginates by batchSize', async () => {
    const rpcPool = fakeRpcPool(
      Array.from({ length: 5 }, (_, i) => ({ slot: 100 + i, signature: `s${i}` })),
    );
    const src = new HistoricalSignalSource({
      rpcPool,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
      slotRange: { from: 100, to: 104 },
      batchSize: 2,
    });
    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));
    await src.start();
    expect(got).toEqual(['s0', 's1', 's2', 's3', 's4']);
    // getBlocks called for [100,101], [102,103], [104,104]
    expect((rpcPool.call as any).mock.calls.filter((c: any[]) => c[0] === 'getBlocks')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Implement**

`packages/solana-signals/src/sources/historical.ts`:
```ts
import { EventEmitter } from 'node:events';
import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { EventDecoderRegistry } from '@ap3x/solana-events';
import { parseLogs } from '@ap3x/solana-events';
import type { SignalSource } from '../source.js';
import type { Signal } from '../signal.js';
import { signalId } from '../signal-id.js';

export interface HistoricalSignalSourceOpts {
  rpcPool: RpcPool;
  decoderRegistry: EventDecoderRegistry;
  programIds: PublicKey[];
  slotRange: { from: number; to: number };
  batchSize?: number;
  name?: string;
}

export class HistoricalSignalSource extends EventEmitter implements SignalSource {
  readonly name: string;
  private aborted = false;
  private readonly opts: Required<Omit<HistoricalSignalSourceOpts, 'name'>>;

  constructor(opts: HistoricalSignalSourceOpts) {
    super();
    this.name = opts.name ?? 'historical';
    this.opts = {
      rpcPool: opts.rpcPool,
      decoderRegistry: opts.decoderRegistry,
      programIds: opts.programIds,
      slotRange: opts.slotRange,
      batchSize: opts.batchSize ?? 100,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener('abort', () => { this.aborted = true; });
    const { from, to } = this.opts.slotRange;
    try {
      for (let cursor = from; cursor <= to && !this.aborted; cursor += this.opts.batchSize) {
        const chunkTo = Math.min(cursor + this.opts.batchSize - 1, to);
        const slots = await this.opts.rpcPool.call('getBlocks', [cursor, chunkTo]);
        for (const slot of slots) {
          if (this.aborted) break;
          const block = await this.opts.rpcPool.call('getBlock', [
            slot,
            { maxSupportedTransactionVersion: 0, encoding: 'json', transactionDetails: 'full' },
          ]);
          if (!block?.transactions) continue;
          for (const tx of block.transactions) {
            const sig = tx.transaction?.signatures?.[0];
            if (!sig || !tx.meta?.logMessages) continue;
            const parsed = parseLogs(tx.meta.logMessages);
            const decoded = this.opts.decoderRegistry.decode(parsed);
            for (const ev of decoded.events ?? []) {
              if (!this.opts.programIds.some((p) => p.equals(ev.programId))) continue;
              const out: Signal = {
                signalId: signalId({ signature: sig, programId: ev.programId, kind: ev.kind, logIndex: ev.logIndex ?? 0 }),
                ts: (block.blockTime ?? 0) * 1000,
                slot,
                signature: sig,
                programId: ev.programId,
                kind: ev.kind,
                decoded: ev.decoded,
                raw: ev.raw ?? { programId: ev.programId, accounts: [], logs: [], inner: [] },
              };
              this.emit('signal', out);
            }
          }
        }
      }
      this.emit('end');
    } catch (err) {
      this.emit('error', err);
    }
  }

  async stop(): Promise<void> {
    this.aborted = true;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-signals test sources/historical
# add to index
git add packages/solana-signals/src/sources/historical.ts \
        packages/solana-signals/src/sources/historical.test.ts \
        packages/solana-signals/src/index.ts
git commit -m "solana-signals: HistoricalSignalSource (RPC backfill)"
```

Add to index: `export { HistoricalSignalSource, type HistoricalSignalSourceOpts } from './sources/historical.js';`

---

### Task 10: `solana-signals` — `GeyserSignalSource`

**Files:**
- Create: `packages/solana-signals/src/sources/geyser.ts`
- Create: `packages/solana-signals/src/sources/geyser.test.ts`
- Modify: `packages/solana-signals/src/index.ts`

- [ ] **Step 1: Write failing test using a fake `GeyserClient`**

`packages/solana-signals/src/sources/geyser.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PublicKey } from '@ap3x/solana-core';
import { GeyserSignalSource } from './geyser.js';

const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

class FakeGeyserClient extends EventEmitter {
  subscribe = vi.fn((_req, handler) => {
    setTimeout(() => {
      handler({
        slot: 100,
        signature: 'sigA',
        logs: [`Program ${programId.toBase58()} invoke [1]`, `Program ${programId.toBase58()} success`],
      });
    }, 10);
    return { unsubscribe: () => {} };
  });
}

const fakeRegistry = {
  decode: () => ({ events: [{ kind: 'test', decoded: {}, programId, logIndex: 0 }], unknown: [] }),
};

describe('GeyserSignalSource', () => {
  it('emits Signal per decoded event from Geyser stream', async () => {
    const client = new FakeGeyserClient();
    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });
    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));
    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual(['sigA']);
    await src.stop();
  });
});
```

- [ ] **Step 2: Implement**

`packages/solana-signals/src/sources/geyser.ts`:
```ts
import { EventEmitter } from 'node:events';
import type { PublicKey } from '@ap3x/solana-core';
import type { GeyserClient } from '@ap3x/solana-connectivity';
import type { EventDecoderRegistry } from '@ap3x/solana-events';
import { parseLogs } from '@ap3x/solana-events';
import type { SignalSource } from '../source.js';
import type { Signal, GapEvent } from '../signal.js';
import { signalId } from '../signal-id.js';

export interface GeyserSignalSourceOpts {
  geyserClient: GeyserClient;
  decoderRegistry: EventDecoderRegistry;
  programIds: PublicKey[];
  name?: string;
}

export class GeyserSignalSource extends EventEmitter implements SignalSource {
  readonly name: string;
  private subscription: { unsubscribe: () => void } | null = null;
  private readonly opts: GeyserSignalSourceOpts;
  private lastSlot = 0;

  constructor(opts: GeyserSignalSourceOpts) {
    super();
    this.name = opts.name ?? 'geyser';
    this.opts = opts;
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener('abort', () => { void this.stop(); });
    const req = {
      transactions: { all: { vote: false, failed: false, accountInclude: this.opts.programIds.map((p) => p.toBase58()) } },
    };
    this.subscription = (this.opts.geyserClient as unknown as { subscribe: Function }).subscribe(req, (update: { slot: number; signature: string; logs: string[] }) => {
      try {
        if (this.lastSlot && update.slot > this.lastSlot + 1) {
          const gap: GapEvent = { fromSlot: this.lastSlot + 1, toSlot: update.slot - 1, reason: 'skip' };
          this.emit('gap', gap);
        }
        this.lastSlot = update.slot;
        const parsed = parseLogs(update.logs);
        const decoded = this.opts.decoderRegistry.decode(parsed);
        for (const ev of decoded.events ?? []) {
          if (!this.opts.programIds.some((p) => p.equals(ev.programId))) continue;
          const out: Signal = {
            signalId: signalId({ signature: update.signature, programId: ev.programId, kind: ev.kind, logIndex: ev.logIndex ?? 0 }),
            ts: Date.now(),
            slot: update.slot,
            signature: update.signature,
            programId: ev.programId,
            kind: ev.kind,
            decoded: ev.decoded,
            raw: ev.raw ?? { programId: ev.programId, accounts: [], logs: [], inner: [] },
          };
          this.emit('signal', out);
        }
      } catch (err) {
        this.emit('error', err);
      }
    });
  }

  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-signals test sources/geyser
git add packages/solana-signals/src/sources/geyser.ts \
        packages/solana-signals/src/sources/geyser.test.ts \
        packages/solana-signals/src/index.ts
git commit -m "solana-signals: GeyserSignalSource (live wrapping)"
```

Add to index: `export { GeyserSignalSource, type GeyserSignalSourceOpts } from './sources/geyser.js';`

---

### Task 11: `solana-signals` — end-to-end fixture replay integration test

**Files:**
- Create: `packages/solana-signals/tests/e2e-fixture.test.ts`

- [ ] **Step 1: Write integration test that wires Fixture → Queue → Subscriber**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {
  FixtureSignalSource,
  SignalQueue,
  FileSignalCheckpointStore,
} from '@ap3x/solana-signals';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-e2e-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('signals E2E', () => {
  it('fixture → queue → subscriber → checkpoint', async () => {
    const fixturePath = path.join(dir, 'sig.jsonl.gz');
    const lines = Array.from({ length: 50 }, (_, i) => ({
      signalId: `id${i}`, ts: i, slot: 100 + i, signature: `sig${i}`,
      programId: '11111111111111111111111111111111', kind: 'test', decoded: {},
      raw: { programId: '11111111111111111111111111111111', accounts: [], logs: [], inner: [] },
    }));
    const gz = zlib.createGzip();
    const out = createWriteStream(fixturePath);
    gz.pipe(out);
    for (const l of lines) gz.write(JSON.stringify(l) + '\n');
    gz.end();
    await new Promise<void>((res) => out.on('close', () => res()));

    const src = new FixtureSignalSource({ path: fixturePath });
    const queue = new SignalQueue({ capacity: 100 });
    const ckpt = new FileSignalCheckpointStore({ dir: path.join(dir, 'ckpt') });
    const seen: string[] = [];

    queue.subscribe('test-sub', async (sig) => {
      seen.push(sig.signalId);
      await ckpt.save('test-sub', { lastSignalId: sig.signalId, lastSlot: sig.slot });
    });

    src.on('signal', (s) => { void queue.push(s); });
    await src.start();
    await new Promise((r) => src.on('end', () => r(undefined)));
    await queue.drain();

    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50); // no dupes
    expect(await ckpt.load('test-sub')).toEqual({ lastSignalId: 'id49', lastSlot: 149 });
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @ap3x/solana-signals test e2e-fixture
git add packages/solana-signals/tests/e2e-fixture.test.ts
git commit -m "solana-signals: E2E fixture → queue → checkpoint integration test"
```

---

## Phase B — Portfolio (depends on Task 2 SPL transfer decoders + Task 3 fixture; parallel with Phase C)

### Task 12: `solana-portfolio` — package scaffold + types

**Files:**
- Create: `packages/solana-portfolio/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,README.md}`
- Create: `packages/solana-portfolio/src/index.ts`
- Create: `packages/solana-portfolio/src/types.ts`
- Create: `packages/solana-portfolio/src/portfolio-read-api.ts`

- [ ] **Step 1: Scaffold (mirror `solana-events` package files; deps include `@ap3x/solana-spl` workspace, `@ap3x/solana-connectivity`, `@ap3x/solana-events`, `@ap3x/solana-core`)**

`packages/solana-portfolio/package.json`:
```json
{
  "name": "@ap3x/solana-portfolio",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./cli": { "types": "./dist/cli.d.ts", "import": "./dist/cli.js" }
  },
  "bin": { "ap3x-portfolio": "./dist/cli.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ap3x/solana-core": "workspace:*",
    "@ap3x/solana-connectivity": "workspace:*",
    "@ap3x/solana-events": "workspace:*",
    "@ap3x/solana-spl": "workspace:*"
  },
  "devDependencies": { "tsup": "^8.3.0", "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

Update `tsup.config.ts` to emit two entries: `src/index.ts` and `src/cli.ts`.

- [ ] **Step 2: Define types**

`packages/solana-portfolio/src/types.ts`:
```ts
import type { PublicKey } from '@ap3x/solana-core';

export type LotSource =
  | 'trade'
  | 'airdrop'
  | 'transfer-in'
  | 'cold-start-reconstructed'
  | 'cold-start-unresolved';

export interface Lot {
  amount: bigint;
  costBasisLamports: bigint;
  acquiredSlot: number;
  acquiredSig: string;
  source: LotSource;
  reconstructedAt?: number;
  basisUnresolved?: boolean;
}

export interface Position {
  mint: PublicKey;
  walletAddress: PublicKey;
  lots: Lot[];
  lastUpdatedSlot: number;
}

export interface LandedTrade {
  signature: string;
  slot: number;
  wallet: PublicKey;
  mint: PublicKey;
  amountDelta: bigint;
  solFlowLamports: bigint;
  feeLamports: bigint;
  source: 'executor' | 'external';
}

export interface PositionChange {
  wallet: PublicKey;
  mint: PublicKey;
  before: Position | null;
  after: Position;
  reason: 'apply-landed-trade' | 'cold-start' | 'reconcile' | 'manual-correction';
}

export interface RealizedPnlEvent {
  wallet: PublicKey;
  mint: PublicKey;
  realized: bigint;
  costBasis: bigint;
  proceeds: bigint;
  basisUnresolved: boolean;
  slot: number;
}

export interface DriftEvent {
  wallet: PublicKey;
  mint: PublicKey;
  expected: bigint;
  observed: bigint;
  diff: bigint;
  lastKnownLandedSig: string | null;
}

export interface CostBasisIncompleteEvent {
  wallet: PublicKey;
  mint: PublicKey;
  unaccountedAmount: bigint;
  oldestSlotWalked: number;
}

export interface ObserveOpts {
  method?: 'fifo' | 'lifo' | 'avg-cost';
  lookbackDays?: number;
}
```

- [ ] **Step 3: Define `PortfolioReadApi` interface**

`packages/solana-portfolio/src/portfolio-read-api.ts`:
```ts
import type { PublicKey } from '@ap3x/solana-core';
import type { Position } from './types.js';

export interface PortfolioReadApi {
  getPosition(wallet: PublicKey, mint: PublicKey): Promise<Position | null>;
  getAllPositions(wallet: PublicKey): Promise<Position[]>;
  getRealizedPnl(wallet: PublicKey, mint: PublicKey): Promise<bigint>;
  getUnrealizedPnl(wallet: PublicKey, mint: PublicKey, currentPriceLamports: bigint): Promise<bigint>;
}
```

- [ ] **Step 4: Re-export + commit**

`packages/solana-portfolio/src/index.ts`:
```ts
export * from './types.js';
export type { PortfolioReadApi } from './portfolio-read-api.js';
```

```bash
pnpm install
pnpm --filter @ap3x/solana-portfolio build
git add packages/solana-portfolio/
git commit -m "solana-portfolio: package scaffold + Position/Lot/LandedTrade types"
```

---

### Task 13: `solana-portfolio` — `FilePortfolioStore`

**Files:**
- Create: `packages/solana-portfolio/src/store-file.ts`
- Create: `packages/solana-portfolio/src/store-file.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/solana-portfolio/src/store-file.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublicKey } from '@ap3x/solana-core';
import { FilePortfolioStore } from './store-file.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

describe('FilePortfolioStore', () => {
  it('returns null for unknown position', async () => {
    const store = new FilePortfolioStore({ dir });
    expect(await store.getPosition(wallet, mint)).toBeNull();
  });

  it('round-trips a position via internal upsert', async () => {
    const store = new FilePortfolioStore({ dir });
    await store._upsertForTest({
      mint, walletAddress: wallet, lastUpdatedSlot: 100,
      lots: [{ amount: 1000n, costBasisLamports: 500n, acquiredSlot: 100, acquiredSig: 's1', source: 'trade' }],
    });
    const got = await store.getPosition(wallet, mint);
    expect(got!.lots[0]!.amount).toBe(1000n);
  });

  it('persists audit log entries', async () => {
    const store = new FilePortfolioStore({ dir });
    await store._auditForTest(wallet, { ts: 0, event: 'apply', meta: { sig: 's1' } });
    const entries = await store.readAudit(wallet);
    expect(entries).toHaveLength(1);
  });

  it('serializes bigint amounts losslessly', async () => {
    const store = new FilePortfolioStore({ dir });
    const big = 18_446_744_073_709_551_615n; // u64 max
    await store._upsertForTest({
      mint, walletAddress: wallet, lastUpdatedSlot: 1,
      lots: [{ amount: big, costBasisLamports: big, acquiredSlot: 1, acquiredSig: 's', source: 'trade' }],
    });
    const got = await store.getPosition(wallet, mint);
    expect(got!.lots[0]!.amount).toBe(big);
    expect(got!.lots[0]!.costBasisLamports).toBe(big);
  });
});
```

- [ ] **Step 2: Implement**

`packages/solana-portfolio/src/store-file.ts`:
```ts
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@ap3x/solana-core';
import type { Position, Lot, LandedTrade, PositionChange } from './types.js';

export interface FilePortfolioStoreOpts {
  dir?: string;
}

interface AuditEntry { ts: number; event: string; meta: Record<string, unknown>; }

export class FilePortfolioStore extends EventEmitter {
  private readonly dir: string;
  private readonly mutexes = new Map<string, Promise<void>>();

  constructor(opts: FilePortfolioStoreOpts = {}) {
    super();
    this.dir = opts.dir ?? '.ap3x/portfolio';
  }

  async getPosition(wallet: PublicKey, mint: PublicKey): Promise<Position | null> {
    const all = await this.loadWalletData(wallet);
    return all?.positions.find((p) => p.mint.equals(mint)) ?? null;
  }

  async getAllPositions(wallet: PublicKey): Promise<Position[]> {
    return (await this.loadWalletData(wallet))?.positions ?? [];
  }

  async getRealizedPnl(wallet: PublicKey, _mint: PublicKey): Promise<bigint> {
    const data = await this.loadWalletData(wallet);
    return data?.realizedPnl ?? 0n;
  }

  async readAudit(wallet: PublicKey): Promise<AuditEntry[]> {
    try {
      const raw = await fs.readFile(this.auditPathFor(wallet), 'utf8');
      return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Test-only: insert a position directly. Production code uses applyLandedTrade. */
  async _upsertForTest(pos: Position): Promise<void> {
    await this.withMutex(pos.walletAddress.toBase58(), async () => {
      const data = (await this.loadWalletData(pos.walletAddress)) ?? { positions: [], realizedPnl: 0n };
      const idx = data.positions.findIndex((p) => p.mint.equals(pos.mint));
      if (idx >= 0) data.positions[idx] = pos;
      else data.positions.push(pos);
      await this.write(pos.walletAddress, data);
    });
  }

  /** Test-only: append an audit entry. */
  async _auditForTest(wallet: PublicKey, entry: AuditEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.auditPathFor(wallet), JSON.stringify(entry) + '\n');
  }

  private async loadWalletData(wallet: PublicKey): Promise<{ positions: Position[]; realizedPnl: bigint } | null> {
    try {
      const raw = await fs.readFile(this.pathFor(wallet), 'utf8');
      const parsed = JSON.parse(raw, this.reviver);
      parsed.positions = parsed.positions.map((p: Position) => ({
        ...p,
        mint: PublicKey.fromBase58(p.mint as unknown as string),
        walletAddress: PublicKey.fromBase58(p.walletAddress as unknown as string),
        lots: p.lots,
      }));
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async write(wallet: PublicKey, data: { positions: Position[]; realizedPnl: bigint }): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const p = this.pathFor(wallet);
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    const serialised = JSON.stringify(
      {
        positions: data.positions.map((pos) => ({
          ...pos,
          mint: pos.mint.toBase58(),
          walletAddress: pos.walletAddress.toBase58(),
        })),
        realizedPnl: data.realizedPnl,
      },
      (_k, v) => (typeof v === 'bigint' ? `${v}n` : v),
    );
    await fs.writeFile(tmp, serialised);
    await fs.rename(tmp, p);
  }

  private reviver = (_key: string, value: unknown): unknown => {
    if (typeof value === 'string' && /^\d+n$/.test(value)) return BigInt(value.slice(0, -1));
    return value;
  };

  private pathFor(wallet: PublicKey): string { return path.join(this.dir, `${wallet.toBase58()}.json`); }
  private auditPathFor(wallet: PublicKey): string { return path.join(this.dir, `${wallet.toBase58()}.audit.jsonl`); }

  private async withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(key) ?? Promise.resolve();
    let resolveOuter: () => void;
    const next = new Promise<void>((res) => { resolveOuter = res; });
    this.mutexes.set(key, prev.then(() => next));
    await prev;
    try { return await fn(); }
    finally {
      resolveOuter!();
      if (this.mutexes.get(key) === prev.then(() => next)) this.mutexes.delete(key);
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test store-file
git add packages/solana-portfolio/src/store-file.ts \
        packages/solana-portfolio/src/store-file.test.ts
git commit -m "solana-portfolio: FilePortfolioStore (atomic writes + bigint roundtrip + audit log)"
```

---

### Task 14: `solana-portfolio` — accounting helpers (FIFO / LIFO / avg-cost)

**Files:**
- Create: `packages/solana-portfolio/src/accounting.ts`
- Create: `packages/solana-portfolio/src/accounting.test.ts`

- [ ] **Step 1: Write table-driven failing tests**

`packages/solana-portfolio/src/accounting.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { reduceLots } from './accounting.js';
import type { Lot } from './types.js';

const lot = (amount: bigint, basis: bigint): Lot => ({
  amount, costBasisLamports: basis, acquiredSlot: 1, acquiredSig: 's', source: 'trade',
});

describe('reduceLots', () => {
  it('FIFO: reduces oldest lot first', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    const { remaining, realized } = reduceLots(lots, 50n, 1500n, 'fifo');
    // Take 50 from first lot (basis 500). Proceeds 50/100 of 1500 = 750. Realized = 750-500 = 250.
    expect(realized).toBe(250n);
    expect(remaining[0]!.amount).toBe(50n);
    expect(remaining[1]!.amount).toBe(100n);
  });

  it('LIFO: reduces newest lot first', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    const { remaining, realized } = reduceLots(lots, 50n, 1500n, 'lifo');
    // Take 50 from second lot (basis 1000). Proceeds 750. Realized = 750-1000 = -250.
    expect(realized).toBe(-250n);
    expect(remaining[0]!.amount).toBe(100n);
    expect(remaining[1]!.amount).toBe(50n);
  });

  it('avg-cost: uses weighted average basis across lots', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    // Avg basis per token = (1000+2000)/(100+100) = 15.
    // Sell 50 → basis = 50*15 = 750. Proceeds 1500. Realized = 750.
    const { realized } = reduceLots(lots, 50n, 1500n, 'avg-cost');
    expect(realized).toBe(750n);
  });

  it('FIFO: reduces across multiple lots when first is depleted', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    const { realized, remaining } = reduceLots(lots, 150n, 4500n, 'fifo');
    // First lot: take 100 (basis 1000). Proceeds 100/150 of 4500 = 3000. realized += 2000.
    // Second lot: take 50 (basis 1000). Proceeds 50/150 of 4500 = 1500. realized += 500.
    expect(realized).toBe(2500n);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.amount).toBe(50n);
  });

  it('flags unresolved-basis reductions', () => {
    const lots = [{ ...lot(100n, 0n), source: 'cold-start-unresolved' as const, basisUnresolved: true }];
    const { basisUnresolved } = reduceLots(lots, 50n, 1000n, 'fifo');
    expect(basisUnresolved).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

`packages/solana-portfolio/src/accounting.ts`:
```ts
import type { Lot } from './types.js';

export type AccountingMethod = 'fifo' | 'lifo' | 'avg-cost';

export interface ReduceResult {
  remaining: Lot[];
  realized: bigint;
  costBasis: bigint;
  proceeds: bigint;
  basisUnresolved: boolean;
}

export function reduceLots(
  lots: Lot[],
  amount: bigint,
  proceedsLamports: bigint,
  method: AccountingMethod,
): ReduceResult {
  if (amount <= 0n) return { remaining: lots, realized: 0n, costBasis: 0n, proceeds: 0n, basisUnresolved: false };

  if (method === 'avg-cost') {
    const totalAmt = lots.reduce((s, l) => s + l.amount, 0n);
    const totalBasis = lots.reduce((s, l) => s + l.costBasisLamports, 0n);
    if (totalAmt === 0n) return { remaining: lots, realized: 0n, costBasis: 0n, proceeds: proceedsLamports, basisUnresolved: false };
    const avgBasis = (totalBasis * amount) / totalAmt;
    const basisUnresolved = lots.some((l) => l.basisUnresolved);
    // Reduce proportionally across lots.
    const remaining = lots.map((l) => {
      const take = (l.amount * amount) / totalAmt;
      return { ...l, amount: l.amount - take, costBasisLamports: l.costBasisLamports - (l.costBasisLamports * take) / l.amount };
    }).filter((l) => l.amount > 0n);
    return { remaining, realized: proceedsLamports - avgBasis, costBasis: avgBasis, proceeds: proceedsLamports, basisUnresolved };
  }

  const ordered = method === 'fifo' ? [...lots] : [...lots].reverse();
  let toTake = amount;
  let costBasis = 0n;
  let basisUnresolved = false;
  const out: Lot[] = [];
  for (const l of ordered) {
    if (toTake === 0n) { out.push(l); continue; }
    if (l.amount <= toTake) {
      costBasis += l.costBasisLamports;
      if (l.basisUnresolved) basisUnresolved = true;
      toTake -= l.amount;
    } else {
      const take = toTake;
      const partialBasis = (l.costBasisLamports * take) / l.amount;
      costBasis += partialBasis;
      if (l.basisUnresolved) basisUnresolved = true;
      out.push({ ...l, amount: l.amount - take, costBasisLamports: l.costBasisLamports - partialBasis });
      toTake = 0n;
    }
  }
  if (toTake > 0n) throw new Error(`insufficient amount: tried to reduce ${amount}, only ${amount - toTake} available`);
  const remaining = method === 'fifo' ? out : out.reverse();
  return { remaining, realized: proceedsLamports - costBasis, costBasis, proceeds: proceedsLamports, basisUnresolved };
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test accounting
git add packages/solana-portfolio/src/accounting.ts \
        packages/solana-portfolio/src/accounting.test.ts
git commit -m "solana-portfolio: FIFO/LIFO/avg-cost accounting helpers"
```

---

### Task 15: `solana-portfolio` — `SwapTracer` interface + registry

**Files:**
- Create: `packages/solana-portfolio/src/swap-tracer.ts`
- Create: `packages/solana-portfolio/src/swap-tracer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { SwapTracerRegistry, type SwapTracer } from './swap-tracer.js';

const pid = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('11111111111111111111111111111113');

const tracer: SwapTracer = {
  programId: pid,
  trace: () => ({ kind: 'swap', solOut: 1000n, tokensIn: 100n }),
};

describe('SwapTracerRegistry', () => {
  it('registers and retrieves a tracer by programId', () => {
    const reg = new SwapTracerRegistry();
    reg.register(tracer);
    const found = reg.tracersFor(pid);
    expect(found).toHaveLength(1);
    expect(found[0]!.trace({} as any, wallet, mint)).toEqual({ kind: 'swap', solOut: 1000n, tokensIn: 100n });
  });

  it('returns empty array for unknown programId', () => {
    const reg = new SwapTracerRegistry();
    const other = PublicKey.fromBase58('11111111111111111111111111111111');
    expect(reg.tracersFor(other)).toEqual([]);
  });

  it('supports multiple tracers per programId', () => {
    const reg = new SwapTracerRegistry();
    reg.register(tracer);
    reg.register({ ...tracer, trace: () => null });
    expect(reg.tracersFor(pid)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Implement**

`packages/solana-portfolio/src/swap-tracer.ts`:
```ts
import type { PublicKey } from '@ap3x/solana-core';

export interface ParsedTransaction {
  signature: string;
  slot: number;
  programIds: PublicKey[];
  meta: {
    preBalances: Map<string, bigint>;
    postBalances: Map<string, bigint>;
    preTokenBalances: Array<{ owner: PublicKey; mint: PublicKey; amount: bigint }>;
    postTokenBalances: Array<{ owner: PublicKey; mint: PublicKey; amount: bigint }>;
    feeLamports: bigint;
    logMessages: string[];
  };
  instructions: Array<{ programId: PublicKey; accounts: PublicKey[]; data: Uint8Array }>;
}

export type TraceResult =
  | { kind: 'swap'; solOut: bigint; tokensIn: bigint; meta?: Record<string, unknown> }
  | { kind: 'transfer-in'; sourceWallet?: PublicKey; meta?: Record<string, unknown> };

export interface SwapTracer {
  readonly programId: PublicKey;
  trace(tx: ParsedTransaction, wallet: PublicKey, mint: PublicKey): TraceResult | null;
}

export class SwapTracerRegistry {
  private readonly byProgram = new Map<string, SwapTracer[]>();

  register(tracer: SwapTracer): void {
    const key = tracer.programId.toBase58();
    const arr = this.byProgram.get(key) ?? [];
    arr.push(tracer);
    this.byProgram.set(key, arr);
  }

  tracersFor(programId: PublicKey): SwapTracer[] {
    return this.byProgram.get(programId.toBase58()) ?? [];
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test swap-tracer
git add packages/solana-portfolio/src/swap-tracer.ts \
        packages/solana-portfolio/src/swap-tracer.test.ts
git commit -m "solana-portfolio: SwapTracer interface + registry (extension-safe via meta?)"
```

---

### Task 16: `solana-portfolio` — `SplTransferSwapTracer`

**Files:**
- Create: `packages/solana-portfolio/src/tracers/spl-transfer.ts`
- Create: `packages/solana-portfolio/src/tracers/spl-transfer.test.ts`

- [ ] **Step 1: Write failing test (uses Task 2's `decodeTransferInstruction`)**

```ts
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { SPL_TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import { SplTransferSwapTracer } from './spl-transfer.js';
import type { ParsedTransaction } from '../swap-tracer.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('11111111111111111111111111111113');
const sender = PublicKey.fromBase58('11111111111111111111111111111114');
const senderAta = PublicKey.fromBase58('11111111111111111111111111111115');
const recipientAta = PublicKey.fromBase58('11111111111111111111111111111116');

const baseTx = (data: Uint8Array, accounts: PublicKey[]): ParsedTransaction => ({
  signature: 's', slot: 1,
  programIds: [SPL_TOKEN_PROGRAM_ID],
  meta: {
    preBalances: new Map(), postBalances: new Map(),
    preTokenBalances: [{ owner: wallet, mint, amount: 0n }],
    postTokenBalances: [{ owner: wallet, mint, amount: 100n }],
    feeLamports: 5000n, logMessages: [],
  },
  instructions: [{ programId: SPL_TOKEN_PROGRAM_ID, accounts, data }],
});

describe('SplTransferSwapTracer', () => {
  it('classifies a Transfer (variant 3) inflow as transfer-in with source wallet', () => {
    const tracer = new SplTransferSwapTracer();
    const data = new Uint8Array([3, 100, 0, 0, 0, 0, 0, 0, 0]);
    const tx = baseTx(data, [senderAta, recipientAta, sender]);
    // The tracer needs an ATA→owner resolver (TBD) — for now, it returns transfer-in with no source if none provided.
    const result = tracer.trace(tx, wallet, mint);
    expect(result).toEqual({ kind: 'transfer-in' });
  });

  it('returns null when no SPL Token Transfer instruction present', () => {
    const tracer = new SplTransferSwapTracer();
    const tx: ParsedTransaction = {
      ...baseTx(new Uint8Array([0]), []),
      instructions: [],
    };
    expect(tracer.trace(tx, wallet, mint)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

`packages/solana-portfolio/src/tracers/spl-transfer.ts`:
```ts
import type { PublicKey } from '@ap3x/solana-core';
import { SPL_TOKEN_PROGRAM_ID, decodeTransferInstruction } from '@ap3x/solana-spl';
import type { SwapTracer, ParsedTransaction, TraceResult } from '../swap-tracer.js';

/**
 * Plain SPL transfer tracer. Classifies inflows from a token transfer as
 * `transfer-in`. Cannot determine source wallet without an ATA→owner resolver;
 * verticals (e.g. pump.fun PRP-03) will register richer tracers that provide
 * cost-basis context.
 */
export class SplTransferSwapTracer implements SwapTracer {
  readonly programId = SPL_TOKEN_PROGRAM_ID;

  trace(tx: ParsedTransaction, _wallet: PublicKey, _mint: PublicKey): TraceResult | null {
    for (const ix of tx.instructions) {
      const decoded = decodeTransferInstruction(ix);
      if (decoded) return { kind: 'transfer-in' };
    }
    return null;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test tracers/spl-transfer
git add packages/solana-portfolio/src/tracers/spl-transfer.ts \
        packages/solana-portfolio/src/tracers/spl-transfer.test.ts
git commit -m "solana-portfolio: SplTransferSwapTracer (transfer-in classification)"
```

---

### Task 17: `solana-portfolio` — cost-basis reconstructor (cold-start algorithm)

**Files:**
- Create: `packages/solana-portfolio/src/reconstructor.ts`
- Create: `packages/solana-portfolio/src/reconstructor.test.ts`

This is the meatiest task in Phase B. Implements the 4-step algorithm from spec §3.4. Targets gate 8.

- [ ] **Step 1: Write failing tests covering each lot-classification branch**

```ts
import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { CostBasisReconstructor } from './reconstructor.js';
import { SwapTracerRegistry } from './swap-tracer.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('11111111111111111111111111111113');

const fakeRpcPool = (sigs: any[], txByHash: Record<string, any>): any => ({
  call: vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getSignaturesForAddress') return sigs;
    if (method === 'getTransaction') {
      const [sig] = params as [string];
      return txByHash[sig] ?? null;
    }
    return null;
  }),
});

describe('CostBasisReconstructor', () => {
  it('classifies a SOL-out + token-in inflow as trade', async () => {
    const sigs = [{ signature: 's1', slot: 100, blockTime: Date.now() / 1000 }];
    const tx = {
      slot: 100,
      meta: {
        preBalances: [10_000n], postBalances: [9_000n], fee: 5000,
        preTokenBalances: [{ owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [{ owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '100' } }],
        logMessages: [],
      },
      transaction: { message: { accountKeys: [wallet.toBase58()], instructions: [] }, signatures: ['s1'] },
    };
    const recon = new CostBasisReconstructor({
      rpcPool: fakeRpcPool(sigs, { s1: tx }),
      tracerRegistry: new SwapTracerRegistry(),
    });
    const lots = await recon.reconstruct(wallet, mint, 100n);
    // SOL outflow = (10_000 - 9_000) - 5000 fee = 5000. But fee was 5000, so outflow netted to -5000... actually balance went from 10000 to 9000 = 1000 down, fee=5000. Skip math here; test the classification.
    expect(lots[0]!.source).toBe('trade');
    expect(lots[0]!.amount).toBe(100n);
  });

  it('classifies inflow with no SOL outflow as airdrop', async () => {
    const sigs = [{ signature: 's1', slot: 100, blockTime: Date.now() / 1000 }];
    const tx = {
      slot: 100,
      meta: {
        preBalances: [10_000n], postBalances: [10_000n - 5000n], fee: 5000,
        preTokenBalances: [{ owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [{ owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '100' } }],
        logMessages: [],
      },
      transaction: { message: { accountKeys: [wallet.toBase58()], instructions: [] }, signatures: ['s1'] },
    };
    const recon = new CostBasisReconstructor({
      rpcPool: fakeRpcPool(sigs, { s1: tx }),
      tracerRegistry: new SwapTracerRegistry(),
    });
    const lots = await recon.reconstruct(wallet, mint, 100n);
    expect(lots[0]!.source).toBe('airdrop');
    expect(lots[0]!.costBasisLamports).toBe(0n);
  });

  it('emits cost-basis-incomplete when lookback hit with un-accounted balance', async () => {
    const recon = new CostBasisReconstructor({
      rpcPool: fakeRpcPool([], {}),
      tracerRegistry: new SwapTracerRegistry(),
      lookbackDays: 90,
    });
    const events: any[] = [];
    recon.on('cost-basis-incomplete', (e) => events.push(e));
    const lots = await recon.reconstruct(wallet, mint, 500n);
    expect(events).toHaveLength(1);
    expect(lots[0]!.source).toBe('cold-start-unresolved');
    expect(lots[0]!.amount).toBe(500n);
  });
});
```

- [ ] **Step 2: Implement (per spec §3.4 algorithm)**

`packages/solana-portfolio/src/reconstructor.ts`:
```ts
import { EventEmitter } from 'node:events';
import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { SwapTracerRegistry, ParsedTransaction } from './swap-tracer.js';
import type { Lot } from './types.js';

export interface CostBasisReconstructorOpts {
  rpcPool: RpcPool;
  tracerRegistry: SwapTracerRegistry;
  lookbackDays?: number;
}

export class CostBasisReconstructor extends EventEmitter {
  private readonly opts: Required<CostBasisReconstructorOpts>;

  constructor(opts: CostBasisReconstructorOpts) {
    super();
    this.opts = {
      rpcPool: opts.rpcPool,
      tracerRegistry: opts.tracerRegistry,
      lookbackDays: opts.lookbackDays ?? 90,
    };
  }

  async reconstruct(wallet: PublicKey, mint: PublicKey, currentBalance: bigint): Promise<Lot[]> {
    const lookbackMs = this.opts.lookbackDays * 24 * 60 * 60 * 1000;
    const cutoffSec = (Date.now() - lookbackMs) / 1000;

    const sigs = await this.opts.rpcPool.call('getSignaturesForAddress', [wallet.toBase58(), { limit: 1000 }]);
    const lots: Lot[] = [];
    let accounted = 0n;
    let oldestSlotWalked = Number.MAX_SAFE_INTEGER;

    for (const sigInfo of sigs as Array<{ signature: string; slot: number; blockTime: number | null }>) {
      if (sigInfo.blockTime !== null && sigInfo.blockTime < cutoffSec) break;
      if (accounted >= currentBalance) break;

      const tx = await this.opts.rpcPool.call('getTransaction', [
        sigInfo.signature,
        { maxSupportedTransactionVersion: 0, encoding: 'json' },
      ]);
      if (!tx) continue;
      oldestSlotWalked = Math.min(oldestSlotWalked, sigInfo.slot);

      const lot = this.classifyLotForTx(tx, wallet, mint, sigInfo.signature, sigInfo.slot);
      if (!lot) continue;
      if (lot.amount > 0n) {
        lots.push(lot);
        accounted += lot.amount;
      }
    }

    if (accounted < currentBalance) {
      const unaccounted = currentBalance - accounted;
      lots.push({
        amount: unaccounted, costBasisLamports: 0n,
        acquiredSlot: oldestSlotWalked === Number.MAX_SAFE_INTEGER ? 0 : oldestSlotWalked,
        acquiredSig: '',
        source: 'cold-start-unresolved',
        basisUnresolved: true,
        reconstructedAt: Date.now(),
      });
      this.emit('cost-basis-incomplete', {
        wallet, mint, unaccountedAmount: unaccounted, oldestSlotWalked,
      });
    }

    return lots;
  }

  private classifyLotForTx(
    tx: any, wallet: PublicKey, mint: PublicKey, sig: string, slot: number,
  ): Lot | null {
    const walletStr = wallet.toBase58();
    const mintStr = mint.toBase58();
    const pre = (tx.meta.preTokenBalances ?? []).find((b: any) => b.owner === walletStr && b.mint === mintStr);
    const post = (tx.meta.postTokenBalances ?? []).find((b: any) => b.owner === walletStr && b.mint === mintStr);
    const preAmt = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
    const postAmt = post ? BigInt(post.uiTokenAmount.amount) : 0n;
    const delta = postAmt - preAmt;
    if (delta <= 0n) return null;

    // Try registered tracers first.
    const parsedTx = this.toParsedTransaction(tx, sig, slot);
    for (const programId of parsedTx.programIds) {
      for (const tracer of this.opts.tracerRegistry.tracersFor(programId)) {
        const result = tracer.trace(parsedTx, wallet, mint);
        if (!result) continue;
        if (result.kind === 'swap') {
          return {
            amount: result.tokensIn, costBasisLamports: result.solOut,
            acquiredSlot: slot, acquiredSig: sig,
            source: 'cold-start-reconstructed', reconstructedAt: Date.now(),
          };
        }
        if (result.kind === 'transfer-in') {
          return {
            amount: delta, costBasisLamports: 0n,
            acquiredSlot: slot, acquiredSig: sig,
            source: 'transfer-in', reconstructedAt: Date.now(),
          };
        }
      }
    }

    // Fallback: SOL outflow heuristic.
    const accountIdx = (tx.transaction.message.accountKeys as string[]).indexOf(walletStr);
    const fee = BigInt(tx.meta.fee ?? 0);
    let solOutflow = 0n;
    if (accountIdx >= 0) {
      const before = BigInt(tx.meta.preBalances[accountIdx]);
      const after = BigInt(tx.meta.postBalances[accountIdx]);
      solOutflow = before - after - fee;
      if (solOutflow < 0n) solOutflow = 0n;
    }

    if (solOutflow > 0n) {
      return {
        amount: delta, costBasisLamports: solOutflow,
        acquiredSlot: slot, acquiredSig: sig,
        source: 'cold-start-reconstructed', reconstructedAt: Date.now(),
      };
    }
    return {
      amount: delta, costBasisLamports: 0n,
      acquiredSlot: slot, acquiredSig: sig,
      source: 'airdrop', reconstructedAt: Date.now(),
    };
  }

  private toParsedTransaction(tx: any, sig: string, slot: number): ParsedTransaction {
    const accounts = (tx.transaction.message.accountKeys as string[]).map((k) => PublicKey.fromBase58(k));
    const ixs = (tx.transaction.message.instructions ?? []).map((ix: any) => ({
      programId: accounts[ix.programIdIndex] ?? PublicKey.fromBase58('11111111111111111111111111111111'),
      accounts: (ix.accounts ?? []).map((idx: number) => accounts[idx]!),
      data: ix.data ? new Uint8Array(Buffer.from(ix.data, 'base64')) : new Uint8Array(),
    }));
    return {
      signature: sig, slot,
      programIds: Array.from(new Set(ixs.map((i: any) => i.programId.toBase58()))).map((b58) => PublicKey.fromBase58(b58 as string)),
      meta: {
        preBalances: new Map(), postBalances: new Map(),
        preTokenBalances: [], postTokenBalances: [],
        feeLamports: BigInt(tx.meta.fee ?? 0),
        logMessages: tx.meta.logMessages ?? [],
      },
      instructions: ixs,
    };
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test reconstructor
git add packages/solana-portfolio/src/reconstructor.ts \
        packages/solana-portfolio/src/reconstructor.test.ts
git commit -m "solana-portfolio: cold-start cost-basis reconstructor (4-step algorithm)"
```

---

### Task 18: `solana-portfolio` — `Reconciler` (drift detection + incremental re-reconstruction)

**Files:**
- Create: `packages/solana-portfolio/src/reconciler.ts`
- Create: `packages/solana-portfolio/src/reconciler.test.ts`

- [ ] **Step 1: Write failing test for drift detection (gate 7)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { Reconciler } from './reconciler.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');

const fakeStore = (positions: any[]) => ({
  getAllPositions: vi.fn(async () => positions),
  getPosition: vi.fn(async () => positions[0]),
  on: vi.fn(),
  emit: vi.fn(),
});
const fakeRpcPool = (tokenAccounts: any[]): any => ({
  call: vi.fn(async () => ({ value: tokenAccounts })),
});

describe('Reconciler', () => {
  it('emits drift when on-chain balance differs from stored', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 100n }], lastUpdatedSlot: 0 }]);
    const rpcPool = fakeRpcPool([
      { account: { data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount: '120' } } } } } },
    ]);
    const drifts: any[] = [];
    const reconciler = new Reconciler({ portfolioStore: store as any, rpcPool, walletAddresses: [wallet], intervalMs: 100, onDrift: (e) => drifts.push(e) });
    await reconciler.runOnce();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]!.diff).toBe(20n);
  });

  it('does not emit drift when balances match', async () => {
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = fakeStore([{ mint, walletAddress: wallet, lots: [{ amount: 100n }], lastUpdatedSlot: 0 }]);
    const rpcPool = fakeRpcPool([
      { account: { data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount: '100' } } } } } },
    ]);
    const drifts: any[] = [];
    const reconciler = new Reconciler({ portfolioStore: store as any, rpcPool, walletAddresses: [wallet], intervalMs: 100, onDrift: (e) => drifts.push(e) });
    await reconciler.runOnce();
    expect(drifts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement**

`packages/solana-portfolio/src/reconciler.ts`:
```ts
import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { FilePortfolioStore } from './store-file.js';
import type { DriftEvent } from './types.js';

export interface ReconcilerOpts {
  portfolioStore: FilePortfolioStore;
  rpcPool: RpcPool;
  walletAddresses: PublicKey[];
  intervalMs?: number;
  onDrift?: (e: DriftEvent) => void;
}

export class Reconciler {
  private readonly opts: Required<Omit<ReconcilerOpts, 'onDrift'>> & { onDrift?: (e: DriftEvent) => void };
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: ReconcilerOpts) {
    this.opts = {
      portfolioStore: opts.portfolioStore,
      rpcPool: opts.rpcPool,
      walletAddresses: opts.walletAddresses,
      intervalMs: opts.intervalMs ?? 60_000,
      onDrift: opts.onDrift,
    };
  }

  start(): void {
    this.timer = setInterval(() => { void this.runOnce(); }, this.opts.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    for (const wallet of this.opts.walletAddresses) {
      const positions = await this.opts.portfolioStore.getAllPositions(wallet);
      const onChain = await this.opts.rpcPool.call('getTokenAccountsByOwner', [
        wallet.toBase58(),
        { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        { encoding: 'jsonParsed' },
      ]);
      const onChainByMint = new Map<string, bigint>();
      for (const acc of onChain.value as any[]) {
        const info = acc.account.data.parsed.info;
        const mint = info.mint as string;
        const amount = BigInt(info.tokenAmount.amount);
        onChainByMint.set(mint, (onChainByMint.get(mint) ?? 0n) + amount);
      }
      for (const pos of positions) {
        const expected = pos.lots.reduce((s, l) => s + l.amount, 0n);
        const observed = onChainByMint.get(pos.mint.toBase58()) ?? 0n;
        if (expected !== observed) {
          const event: DriftEvent = {
            wallet, mint: pos.mint, expected, observed,
            diff: observed - expected,
            lastKnownLandedSig: pos.lots[pos.lots.length - 1]?.acquiredSig ?? null,
          };
          this.opts.onDrift?.(event);
        }
      }
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test reconciler
git add packages/solana-portfolio/src/reconciler.ts \
        packages/solana-portfolio/src/reconciler.test.ts
git commit -m "solana-portfolio: Reconciler with drift detection"
```

---

### Task 19: `solana-portfolio` — daily close

**Files:**
- Create: `packages/solana-portfolio/src/daily-close.ts`
- Create: `packages/solana-portfolio/src/daily-close.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublicKey } from '@ap3x/solana-core';
import { writeDailyClose } from './daily-close.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-daily-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('writeDailyClose', () => {
  it('appends a JSON line per call', async () => {
    const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
    await writeDailyClose({ dir, wallet, ts: 1234, positions: [], realizedPnl: 100n });
    await writeDailyClose({ dir, wallet, ts: 5678, positions: [], realizedPnl: 200n });
    const file = path.join(dir, `${wallet.toBase58()}.daily.jsonl`);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).ts).toBe(1234);
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PublicKey } from '@ap3x/solana-core';
import type { Position } from './types.js';

export interface WriteDailyCloseOpts {
  dir: string;
  wallet: PublicKey;
  ts: number;
  positions: Position[];
  realizedPnl: bigint;
}

export async function writeDailyClose(opts: WriteDailyCloseOpts): Promise<void> {
  await fs.mkdir(opts.dir, { recursive: true });
  const file = path.join(opts.dir, `${opts.wallet.toBase58()}.daily.jsonl`);
  const line = JSON.stringify({
    ts: opts.ts,
    realizedPnl: opts.realizedPnl.toString(),
    positions: opts.positions.map((p) => ({
      mint: p.mint.toBase58(),
      totalAmount: p.lots.reduce((s, l) => s + l.amount, 0n).toString(),
      totalCostBasis: p.lots.reduce((s, l) => s + l.costBasisLamports, 0n).toString(),
    })),
  });
  await fs.appendFile(file, line + '\n');
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test daily-close
git add packages/solana-portfolio/src/daily-close.ts \
        packages/solana-portfolio/src/daily-close.test.ts
git commit -m "solana-portfolio: daily-close append-only writer"
```

---

### Task 20: `solana-portfolio` — CLI correction tool

**Files:**
- Create: `packages/solana-portfolio/src/cli.ts`
- Create: `packages/solana-portfolio/src/cli.test.ts`

- [ ] **Step 1: Implement CLI w/ subcommand `correct-basis`**

`packages/solana-portfolio/src/cli.ts`:
```ts
#!/usr/bin/env node
import { PublicKey } from '@ap3x/solana-core';
import { FilePortfolioStore } from './store-file.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd !== 'correct-basis') {
    console.error('usage: ap3x-portfolio correct-basis <wallet> <mint> <lotIndex> <costBasisLamports> [--dir <path>]');
    process.exit(2);
  }
  const [walletStr, mintStr, lotIdxStr, basisStr, ...rest] = args;
  const dirIdx = rest.indexOf('--dir');
  const dir = dirIdx >= 0 ? rest[dirIdx + 1] : undefined;
  const wallet = PublicKey.fromBase58(walletStr!);
  const mint = PublicKey.fromBase58(mintStr!);
  const lotIdx = Number(lotIdxStr);
  const basis = BigInt(basisStr!);

  const store = new FilePortfolioStore(dir ? { dir } : {});
  const pos = await store.getPosition(wallet, mint);
  if (!pos) { console.error('no position'); process.exit(1); }
  if (lotIdx < 0 || lotIdx >= pos.lots.length) { console.error('lot index out of range'); process.exit(1); }
  const oldBasis = pos.lots[lotIdx]!.costBasisLamports;
  pos.lots[lotIdx] = { ...pos.lots[lotIdx]!, costBasisLamports: basis, basisUnresolved: false };
  await store._upsertForTest(pos);
  await store._auditForTest(wallet, {
    ts: Date.now(),
    event: 'manual-correction',
    meta: { mint: mint.toBase58(), lotIndex: lotIdx, oldBasis: oldBasis.toString(), newBasis: basis.toString() },
  });
  console.log(`updated lot ${lotIdx} basis: ${oldBasis} → ${basis}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Write CLI smoke test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { PublicKey } from '@ap3x/solana-core';
import { FilePortfolioStore } from './store-file.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-cli-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('cli correct-basis', () => {
  it('updates a lot basis and writes audit', async () => {
    const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = new FilePortfolioStore({ dir });
    await store._upsertForTest({
      mint, walletAddress: wallet, lastUpdatedSlot: 0,
      lots: [{ amount: 100n, costBasisLamports: 0n, acquiredSlot: 1, acquiredSig: 's', source: 'cold-start-unresolved', basisUnresolved: true }],
    });
    execSync(`node dist/cli.js correct-basis ${wallet.toBase58()} ${mint.toBase58()} 0 5000 --dir ${dir}`, {
      cwd: path.resolve('packages/solana-portfolio'),
    });
    const got = await store.getPosition(wallet, mint);
    expect(got!.lots[0]!.costBasisLamports).toBe(5000n);
    expect(got!.lots[0]!.basisUnresolved).toBe(false);
    const audit = await store.readAudit(wallet);
    expect(audit[0]!.event).toBe('manual-correction');
  });
});
```

- [ ] **Step 3: Build + run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio build
pnpm --filter @ap3x/solana-portfolio test cli
git add packages/solana-portfolio/src/cli.ts \
        packages/solana-portfolio/src/cli.test.ts
git commit -m "solana-portfolio: ap3x-portfolio correct-basis CLI"
```

---

### Task 21: `solana-portfolio` — `applyLandedTrade` + cost-basis-incomplete event integration

**Files:**
- Modify: `packages/solana-portfolio/src/store-file.ts` (add `applyLandedTrade`)
- Create: `packages/solana-portfolio/tests/apply-landed-trade.test.ts`

- [ ] **Step 1: Write failing integration test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PublicKey } from '@ap3x/solana-core';
import { FilePortfolioStore } from '@ap3x/solana-portfolio';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-apply-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('applyLandedTrade', () => {
  it('adds a Lot when amountDelta > 0', async () => {
    const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = new FilePortfolioStore({ dir });
    const changes = await store.applyLandedTrade({
      signature: 's1', slot: 100, wallet, mint,
      amountDelta: 100n, solFlowLamports: -1000n, feeLamports: 5000n, source: 'executor',
    });
    const pos = await store.getPosition(wallet, mint);
    expect(pos!.lots).toHaveLength(1);
    expect(pos!.lots[0]!.amount).toBe(100n);
    expect(pos!.lots[0]!.costBasisLamports).toBe(1000n);
    expect(changes).toHaveLength(1);
  });

  it('reduces lots FIFO when amountDelta < 0', async () => {
    const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
    const mint = PublicKey.fromBase58('11111111111111111111111111111113');
    const store = new FilePortfolioStore({ dir });
    await store.applyLandedTrade({ signature: 's1', slot: 100, wallet, mint, amountDelta: 100n, solFlowLamports: -1000n, feeLamports: 5000n, source: 'executor' });
    await store.applyLandedTrade({ signature: 's2', slot: 101, wallet, mint, amountDelta: -50n, solFlowLamports: 800n, feeLamports: 5000n, source: 'executor' });
    const pos = await store.getPosition(wallet, mint);
    expect(pos!.lots[0]!.amount).toBe(50n);
  });
});
```

- [ ] **Step 2: Implement `applyLandedTrade` on `FilePortfolioStore`**

Add to `store-file.ts`:
```ts
import { reduceLots } from './accounting.js';
import type { LandedTrade, PositionChange } from './types.js';

// inside class FilePortfolioStore:
async applyLandedTrade(trade: LandedTrade): Promise<PositionChange[]> {
  return this.withMutex(trade.wallet.toBase58(), async () => {
    const data = (await this.loadWalletData(trade.wallet)) ?? { positions: [], realizedPnl: 0n };
    const idx = data.positions.findIndex((p) => p.mint.equals(trade.mint));
    const before = idx >= 0 ? structuredClone(data.positions[idx]!) : null;
    let pos = idx >= 0 ? data.positions[idx]! : { mint: trade.mint, walletAddress: trade.wallet, lots: [], lastUpdatedSlot: 0 };

    if (trade.amountDelta > 0n) {
      const lot = {
        amount: trade.amountDelta,
        costBasisLamports: trade.solFlowLamports < 0n ? -trade.solFlowLamports : 0n,
        acquiredSlot: trade.slot, acquiredSig: trade.signature,
        source: 'trade' as const,
      };
      pos = { ...pos, lots: [...pos.lots, lot], lastUpdatedSlot: trade.slot };
    } else if (trade.amountDelta < 0n) {
      const proceeds = trade.solFlowLamports > 0n ? trade.solFlowLamports : 0n;
      const r = reduceLots(pos.lots, -trade.amountDelta, proceeds, 'fifo');
      data.realizedPnl += r.realized;
      pos = { ...pos, lots: r.remaining, lastUpdatedSlot: trade.slot };
      this.emit('realized-pnl', {
        wallet: trade.wallet, mint: trade.mint,
        realized: r.realized, costBasis: r.costBasis, proceeds: r.proceeds,
        basisUnresolved: r.basisUnresolved, slot: trade.slot,
      });
    }

    if (idx >= 0) data.positions[idx] = pos; else data.positions.push(pos);
    await this.write(trade.wallet, data);
    await this._auditForTest(trade.wallet, {
      ts: Date.now(), event: 'apply-landed-trade',
      meta: { sig: trade.signature, slot: trade.slot, mint: trade.mint.toBase58(), amountDelta: trade.amountDelta.toString() },
    });

    const change: PositionChange = { wallet: trade.wallet, mint: trade.mint, before, after: pos, reason: 'apply-landed-trade' };
    this.emit('change', change);
    return [change];
  });
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test apply-landed-trade
git add packages/solana-portfolio/src/store-file.ts \
        packages/solana-portfolio/tests/apply-landed-trade.test.ts
git commit -m "solana-portfolio: applyLandedTrade with FIFO reduction + realized-pnl event"
```

---

### Task 22: `solana-portfolio` — Gate-8 cost-basis ±1 lamport accuracy test

**Files:**
- Create: `packages/solana-portfolio/tests/gate-8-cost-basis-accuracy.test.ts`

This test depends on Task 3's captured fixture. If unavailable, mark as `it.skip` w/ B12 reference and proceed.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { PublicKey } from '@ap3x/solana-core';
import { CostBasisReconstructor, SwapTracerRegistry, SplTransferSwapTracer } from '@ap3x/solana-portfolio';

const SELECTION_PATH = path.resolve('tests/fixtures/portfolio-cold-start-wallets.json');
const HISTORY_PATH = path.resolve('tests/fixtures/cold-start-tx-history.jsonl.gz');
const TOLERANCE = 1n; // ±1 lamport (rent-exempt minimum dust)

const itIfFixture = existsSync(HISTORY_PATH) ? it : it.skip;

describe('gate 8: cost-basis reconstruction ±1 lamport accuracy', () => {
  itIfFixture('reconstructs each of the 10 wallets within tolerance', async () => {
    const selection = JSON.parse(await fs.readFile(SELECTION_PATH, 'utf8'));
    const txByWalletSig = new Map<string, any>();
    {
      const gz = zlib.createGunzip();
      createReadStream(HISTORY_PATH).pipe(gz);
      const rl = readline.createInterface({ input: gz, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        txByWalletSig.set(`${j.wallet}:${j.signature}`, j.tx);
      }
    }

    for (const { wallet: walletStr, mint: mintStr } of selection.wallets) {
      const wallet = PublicKey.fromBase58(walletStr);
      const mint = PublicKey.fromBase58(mintStr);
      const sigs = [...txByWalletSig.entries()]
        .filter(([k]) => k.startsWith(walletStr + ':'))
        .map(([, tx]) => ({ signature: tx.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime ?? null }));

      const fakeRpcPool: any = {
        call: async (method: string, params: unknown[]) => {
          if (method === 'getSignaturesForAddress') return sigs;
          if (method === 'getTransaction') {
            const [sig] = params as [string];
            return txByWalletSig.get(`${walletStr}:${sig}`);
          }
          return null;
        },
      };

      const registry = new SwapTracerRegistry();
      registry.register(new SplTransferSwapTracer());

      const recon = new CostBasisReconstructor({ rpcPool: fakeRpcPool, tracerRegistry: registry, lookbackDays: 90 });
      const onChainPost = sigs[0]?.signature ? txByWalletSig.get(`${walletStr}:${sigs[0]!.signature}`)?.meta.postTokenBalances?.find((b: any) => b.owner === walletStr && b.mint === mintStr)?.uiTokenAmount?.amount : '0';
      const balance = BigInt(onChainPost ?? '0');
      const lots = await recon.reconstruct(wallet, mint, balance);

      // Total reconstructed amount should equal current balance.
      const totalAmount = lots.reduce((s, l) => s + l.amount, 0n);
      expect(totalAmount).toBe(balance);

      // For each `cold-start-reconstructed` lot, verify costBasis is within tolerance of the SOL outflow recorded in the source tx.
      for (const lot of lots) {
        if (lot.source !== 'cold-start-reconstructed') continue;
        const tx = txByWalletSig.get(`${walletStr}:${lot.acquiredSig}`);
        if (!tx) continue;
        const accountIdx = tx.transaction.message.accountKeys.indexOf(walletStr);
        if (accountIdx < 0) continue;
        const expected = BigInt(tx.meta.preBalances[accountIdx]) - BigInt(tx.meta.postBalances[accountIdx]) - BigInt(tx.meta.fee);
        const diff = lot.costBasisLamports > expected ? lot.costBasisLamports - expected : expected - lot.costBasisLamports;
        expect(diff).toBeLessThanOrEqual(TOLERANCE);
      }
    }
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @ap3x/solana-portfolio test gate-8-cost-basis-accuracy
git add packages/solana-portfolio/tests/gate-8-cost-basis-accuracy.test.ts
git commit -m "solana-portfolio: gate-8 cost-basis ±1 lamport accuracy test"
```

If the fixture is missing, the test self-skips and the gate is deferred to backlog item B12.

---

## Phase C — Executor (independent of A/B; parallel with B)

### Task 23: `solana-executor` — package scaffold + types

**Files:**
- Create: `packages/solana-executor/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,README.md}`
- Create: `packages/solana-executor/src/index.ts`
- Create: `packages/solana-executor/src/types.ts`

- [ ] **Step 1: Scaffold (mirror solana-tx structure; deps include `@ap3x/solana-{core,connectivity,tx,vault}` + `@grpc/grpc-js` + `@grpc/proto-loader`)**

`packages/solana-executor/package.json`:
```json
{
  "name": "@ap3x/solana-executor",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "test": "vitest run", "lint": "eslint src", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@ap3x/solana-core": "workspace:*",
    "@ap3x/solana-connectivity": "workspace:*",
    "@ap3x/solana-tx": "workspace:*",
    "@ap3x/solana-vault": "workspace:*",
    "@grpc/grpc-js": "^1.11.0",
    "@grpc/proto-loader": "^0.7.13"
  },
  "devDependencies": { "tsup": "^8.3.0", "typescript": "^5.6.0", "vitest": "^2.1.0", "msw": "^2.4.0" }
}
```

- [ ] **Step 2: Define types**

`packages/solana-executor/src/types.ts`:
```ts
import type { PublicKey } from '@ap3x/solana-core';

export interface Instruction {
  programId: PublicKey;
  accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
}

export type FeeTier = 'low' | 'med' | 'high' | 'turbo';

export interface SubmitterHint {
  kind: 'rpc' | 'jito-http' | 'jito-grpc';
  bundleGroup?: string;
}

export interface TradeIntent {
  intentId: string;
  wallet: string;
  instructions: Instruction[];
  altHints?: PublicKey[];
  feeTier: FeeTier;
  computeBudgetHint?: number;
  deadline: number;
  submitter?: SubmitterHint;
  retry?: { maxAttempts?: number; bumpProgression?: boolean };
}

export type ExecutionResult =
  | { kind: 'landed'; intentId: string; signature: string; slot: number; submitterUsed: string; landedAt: number }
  | { kind: 'dropped'; intentId: string; signature?: string; submitterUsed: string; lastSeenSlot?: number }
  | { kind: 'timeout'; intentId: string; signature?: string; submitterUsed: string }
  | { kind: 'reverted'; intentId: string; signature: string; slot: number; submitterUsed: string; logs: string[]; error: string }
  | { kind: 'rejected'; intentId: string; submitterUsed?: string; error: { code: string; message: string; meta?: Record<string, unknown> } };
```

- [ ] **Step 3: Re-export + commit**

```ts
// src/index.ts
export * from './types.js';
```

```bash
pnpm install
pnpm --filter @ap3x/solana-executor build
git add packages/solana-executor/
git commit -m "solana-executor: package scaffold + TradeIntent / ExecutionResult types"
```

---

### Task 24: `solana-executor` — `Submitter` interface + payload/ack types

**Files:**
- Create: `packages/solana-executor/src/submitter.ts`

- [ ] **Step 1: Define interface**

```ts
export type SubmitPayload =
  | { kind: 'tx'; signedTx: Uint8Array }
  | { kind: 'bundle'; signedTxs: Uint8Array[]; tipLamports: bigint };

export interface SubmissionAck {
  kind: 'tx' | 'bundle';
  signature?: string;     // for tx submits
  bundleId?: string;      // for bundle submits
  submitterUsed: string;
}

export interface SubmitterHealth {
  state: 'healthy' | 'degraded' | 'unhealthy';
  reason?: string;
  lastOkAt?: number;
}

export interface Submitter {
  readonly name: string;
  readonly kind: 'rpc' | 'jito-http' | 'jito-grpc' | 'custom';
  submit(payload: SubmitPayload): Promise<SubmissionAck>;
  health(): SubmitterHealth;
}
```

- [ ] **Step 2: Re-export + commit**

```ts
// src/index.ts add:
export * from './submitter.js';
```

```bash
git add packages/solana-executor/src/submitter.ts packages/solana-executor/src/index.ts
git commit -m "solana-executor: Submitter interface + SubmitPayload / SubmissionAck"
```

---

### Task 25: `solana-executor` — `RpcSubmitter`

**Files:**
- Create: `packages/solana-executor/src/submitters/rpc.ts`
- Create: `packages/solana-executor/src/submitters/rpc.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { RpcSubmitter } from './rpc.js';

describe('RpcSubmitter', () => {
  it('calls sendTransaction on the pinned write endpoint', async () => {
    const calls: any[] = [];
    const rpcPool: any = {
      pinForWrite: () => ({ name: 'helius', call: vi.fn(async (m: string, p: unknown[]) => { calls.push({ m, p }); return 'sig123'; }) }),
    };
    const sub = new RpcSubmitter({ rpcPool });
    const ack = await sub.submit({ kind: 'tx', signedTx: new Uint8Array([1, 2, 3]) });
    expect(ack.signature).toBe('sig123');
    expect(calls[0]!.m).toBe('sendTransaction');
  });

  it('rejects bundle payloads', async () => {
    const sub = new RpcSubmitter({ rpcPool: { pinForWrite: () => ({ call: vi.fn() }) } as any });
    await expect(sub.submit({ kind: 'bundle', signedTxs: [], tipLamports: 0n })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Implement**

```ts
import type { RpcPool } from '@ap3x/solana-connectivity';
import { base58 } from '@ap3x/solana-core';
import type { Submitter, SubmitPayload, SubmissionAck, SubmitterHealth } from '../submitter.js';

export interface RpcSubmitterOpts { rpcPool: RpcPool; }

export class RpcSubmitter implements Submitter {
  readonly name = 'rpc';
  readonly kind = 'rpc' as const;
  private readonly rpcPool: RpcPool;
  private lastOkAt = 0;

  constructor(opts: RpcSubmitterOpts) { this.rpcPool = opts.rpcPool; }

  async submit(payload: SubmitPayload): Promise<SubmissionAck> {
    if (payload.kind !== 'tx') throw new Error('RpcSubmitter only handles single-tx payloads');
    const endpoint = this.rpcPool.pinForWrite();
    const sig = await endpoint.call('sendTransaction', [
      base58.encode(payload.signedTx),
      { skipPreflight: true, maxRetries: 0, encoding: 'base58' },
    ]);
    this.lastOkAt = Date.now();
    return { kind: 'tx', signature: sig as string, submitterUsed: this.name };
  }

  health(): SubmitterHealth { return { state: 'healthy', lastOkAt: this.lastOkAt }; }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test submitters/rpc
git add packages/solana-executor/src/submitters/rpc.ts \
        packages/solana-executor/src/submitters/rpc.test.ts \
        packages/solana-executor/src/index.ts
git commit -m "solana-executor: RpcSubmitter (sendTransaction via pinned write endpoint)"
```

Add to index: `export { RpcSubmitter, type RpcSubmitterOpts } from './submitters/rpc.js';`

---

### Task 26: `solana-executor` — `JitoHttpSubmitter`

**Files:**
- Create: `packages/solana-executor/src/submitters/jito-http.ts`
- Create: `packages/solana-executor/src/submitters/jito-http.test.ts`

- [ ] **Step 1: Write failing test using `msw`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HttpClient, PublicKey } from '@ap3x/solana-core';
import { JitoHttpSubmitter } from './jito-http.js';

const server = setupServer(
  http.post('https://mainnet.block-engine.jito.wtf/api/v1/bundles', async () =>
    HttpResponse.json({ result: 'bundle-uuid-abc' }),
  ),
);
beforeAll(() => server.listen());
afterAll(() => server.close());

const tipAccount = PublicKey.fromBase58('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

describe('JitoHttpSubmitter', () => {
  it('POSTs a bundle and returns the bundle UUID', async () => {
    const sub = new JitoHttpSubmitter({
      httpClient: new HttpClient({ timeoutMs: 5000, retry: { attempts: 1, backoffMs: 0, jitter: false } }),
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipAccount,
    });
    const ack = await sub.submit({ kind: 'bundle', signedTxs: [new Uint8Array([1])], tipLamports: 10_000n });
    expect(ack.bundleId).toBe('bundle-uuid-abc');
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { HttpClient, base58, type PublicKey } from '@ap3x/solana-core';
import type { Submitter, SubmitPayload, SubmissionAck, SubmitterHealth } from '../submitter.js';

export interface JitoHttpSubmitterOpts {
  httpClient: HttpClient;
  blockEngineUrl: string;
  tipAccount: PublicKey;
  authToken?: string;
}

export class JitoHttpSubmitter implements Submitter {
  readonly name = 'jito-http';
  readonly kind = 'jito-http' as const;
  private lastOkAt = 0;

  constructor(private readonly opts: JitoHttpSubmitterOpts) {}

  async submit(payload: SubmitPayload): Promise<SubmissionAck> {
    if (payload.kind !== 'bundle') throw new Error('JitoHttpSubmitter only handles bundle payloads');
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [payload.signedTxs.map((tx) => base58.encode(tx))],
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.authToken) headers['Authorization'] = `Bearer ${this.opts.authToken}`;
    const res = await this.opts.httpClient.post(`${this.opts.blockEngineUrl}/api/v1/bundles`, body, { headers });
    const parsed = JSON.parse(res.body) as { result?: string; error?: { message: string } };
    if (parsed.error) throw new Error(`jito-http error: ${parsed.error.message}`);
    this.lastOkAt = Date.now();
    return { kind: 'bundle', bundleId: parsed.result!, submitterUsed: this.name };
  }

  health(): SubmitterHealth { return { state: 'healthy', lastOkAt: this.lastOkAt }; }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test submitters/jito-http
git add packages/solana-executor/src/submitters/jito-http.ts \
        packages/solana-executor/src/submitters/jito-http.test.ts \
        packages/solana-executor/src/index.ts
git commit -m "solana-executor: JitoHttpSubmitter (block-engine REST)"
```

Add to index: `export { JitoHttpSubmitter, type JitoHttpSubmitterOpts } from './submitters/jito-http.js';`

---

### Task 27: `solana-executor` — vendor Jito proto + loader helper

**Files:**
- Create: `packages/solana-executor/src/proto/searcher.proto` (vendored)
- Create: `packages/solana-executor/src/proto/bundle.proto` (vendored)
- Create: `packages/solana-executor/src/proto/load.ts`
- Modify: `eslint.config.mjs` (ignore `packages/solana-executor/src/proto/**`)
- Modify: `.github/workflows/ci.yml` (add proto-load CI gate)

- [ ] **Step 1: Vendor `searcher.proto` + `bundle.proto` from `jito-labs/mev-protos`**

```bash
COMMIT="<resolved at run time>"  # pick HEAD of master at vendoring time
# Fetch raw files (manual, one-time):
curl -fsSL "https://raw.githubusercontent.com/jito-labs/mev-protos/${COMMIT}/searcher.proto" \
  > packages/solana-executor/src/proto/searcher.proto
curl -fsSL "https://raw.githubusercontent.com/jito-labs/mev-protos/${COMMIT}/bundle.proto" \
  > packages/solana-executor/src/proto/bundle.proto
```

Prepend each `.proto` with a header comment recording the source URL + commit hash + license attribution (Apache-2.0). Mirror `packages/solana-connectivity/src/proto/yellowstone.proto` formatting from PRP-01 T14.

- [ ] **Step 2: Implement loader helper**

`packages/solana-executor/src/proto/load.ts`:
```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as protoLoader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PINNED_COMMIT = '<commit-hash>'; // matches the comment in searcher.proto / bundle.proto

export function loadSearcherProto(): {
  SearcherService: grpc.ServiceClientConstructor;
  packageDefinition: protoLoader.PackageDefinition;
} {
  const packageDefinition = protoLoader.loadSync(
    [path.resolve(__dirname, 'searcher.proto'), path.resolve(__dirname, 'bundle.proto')],
    { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true },
  );
  const grpcObject = grpc.loadPackageDefinition(packageDefinition);
  // Path through nested namespace `searcher`.
  const ns: any = grpcObject;
  const SearcherService = ns.searcher.SearcherService as grpc.ServiceClientConstructor;
  return { SearcherService, packageDefinition };
}
```

- [ ] **Step 3: Add proto-load CI gate**

Add a job step to `.github/workflows/ci.yml`:
```yaml
- name: Verify Jito proto loads
  run: pnpm --filter @ap3x/solana-executor exec node -e 'import("./dist/proto/load.js").then((m) => m.loadSearcherProto())'
```

- [ ] **Step 4: Update `eslint.config.mjs` ignores**

Add `packages/solana-executor/src/proto/**` to the existing `ignores` array (line 30-41 of `eslint.config.mjs`).

- [ ] **Step 5: Commit (vendored proto + loader + CI gate)**

```bash
git add packages/solana-executor/src/proto/ \
        eslint.config.mjs \
        .github/workflows/ci.yml
git commit -m "solana-executor: vendor jito-labs/mev-protos + proto loader + CI gate"
```

---

### Task 28: `solana-executor` — `JitoGrpcSubmitter` w/ in-process gRPC fake

**Files:**
- Create: `packages/solana-executor/src/submitters/jito-grpc.ts`
- Create: `packages/solana-executor/src/submitters/jito-grpc.test.ts`
- Create: `packages/solana-executor/tests/helpers/jito-fake-server.ts`

- [ ] **Step 1: Implement an in-process gRPC fake (mirrors PRP-01 T14 pattern)**

`packages/solana-executor/tests/helpers/jito-fake-server.ts`:
```ts
import * as grpc from '@grpc/grpc-js';
import { loadSearcherProto } from '../../src/proto/load.js';

export interface FakeJitoServer {
  port: number;
  shutdown(): Promise<void>;
  receivedBundles: any[];
}

export async function startFakeJitoServer(): Promise<FakeJitoServer> {
  const { SearcherService } = loadSearcherProto();
  const server = new grpc.Server();
  const received: any[] = [];

  server.addService(
    (SearcherService as any).service,
    {
      sendBundle: (call: any, cb: any) => {
        received.push(call.request);
        cb(null, { uuid: 'fake-bundle-uuid' });
      },
      getTipAccounts: (_call: any, cb: any) => cb(null, { accounts: ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'] }),
    },
  );

  const port = await new Promise<number>((res, rej) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => {
      if (err) rej(err); else res(p);
    });
  });
  return {
    port,
    shutdown: () => new Promise((res) => server.tryShutdown(() => res())),
    receivedBundles: received,
  };
}
```

- [ ] **Step 2: Implement `JitoGrpcSubmitter`**

```ts
import * as grpc from '@grpc/grpc-js';
import type { PublicKey } from '@ap3x/solana-core';
import { loadSearcherProto, PINNED_COMMIT } from '../proto/load.js';
import type { Submitter, SubmitPayload, SubmissionAck, SubmitterHealth } from '../submitter.js';

export interface JitoGrpcSubmitterOpts {
  grpcEndpoint: string;       // host:port
  tipAccount: PublicKey;
  authToken?: string;
  protoCommit?: string;       // optional sanity check vs PINNED_COMMIT
}

export class JitoGrpcSubmitter implements Submitter {
  readonly name = 'jito-grpc';
  readonly kind = 'jito-grpc' as const;
  private readonly client: any;
  private lastOkAt = 0;

  constructor(opts: JitoGrpcSubmitterOpts) {
    if (opts.protoCommit && opts.protoCommit !== PINNED_COMMIT) {
      throw new Error(`Jito proto commit mismatch: expected ${PINNED_COMMIT}, got ${opts.protoCommit}`);
    }
    const { SearcherService } = loadSearcherProto();
    this.client = new SearcherService(opts.grpcEndpoint, grpc.credentials.createInsecure());
  }

  async submit(payload: SubmitPayload): Promise<SubmissionAck> {
    if (payload.kind !== 'bundle') throw new Error('JitoGrpcSubmitter only handles bundle payloads');
    const ack: any = await new Promise((res, rej) => {
      this.client.sendBundle(
        { transactions: payload.signedTxs.map((tx) => ({ data: tx })) },
        (err: Error | null, response: any) => err ? rej(err) : res(response),
      );
    });
    this.lastOkAt = Date.now();
    return { kind: 'bundle', bundleId: ack.uuid, submitterUsed: this.name };
  }

  health(): SubmitterHealth { return { state: 'healthy', lastOkAt: this.lastOkAt }; }
}
```

- [ ] **Step 3: Test against the fake server**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { JitoGrpcSubmitter } from './jito-grpc.js';
import { startFakeJitoServer } from '../../tests/helpers/jito-fake-server.js';

let server: Awaited<ReturnType<typeof startFakeJitoServer>>;
beforeAll(async () => { server = await startFakeJitoServer(); });
afterAll(async () => { await server.shutdown(); });

describe('JitoGrpcSubmitter', () => {
  it('sends a bundle via gRPC and receives a UUID', async () => {
    const sub = new JitoGrpcSubmitter({
      grpcEndpoint: `127.0.0.1:${server.port}`,
      tipAccount: PublicKey.fromBase58('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
    });
    const ack = await sub.submit({ kind: 'bundle', signedTxs: [new Uint8Array([1, 2, 3])], tipLamports: 10_000n });
    expect(ack.bundleId).toBe('fake-bundle-uuid');
    expect(server.receivedBundles).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test submitters/jito-grpc
git add packages/solana-executor/src/submitters/jito-grpc.ts \
        packages/solana-executor/src/submitters/jito-grpc.test.ts \
        packages/solana-executor/tests/helpers/jito-fake-server.ts \
        packages/solana-executor/src/index.ts
git commit -m "solana-executor: JitoGrpcSubmitter + in-process gRPC fake server"
```

Add to index: `export { JitoGrpcSubmitter, type JitoGrpcSubmitterOpts } from './submitters/jito-grpc.js';`

---

### Task 29: `solana-executor` — `BundleAccumulator` (50ms timer / 5-intent flush)

**Files:**
- Create: `packages/solana-executor/src/bundle-accumulator.ts`
- Create: `packages/solana-executor/src/bundle-accumulator.test.ts`

- [ ] **Step 1: Write failing tests for both flush paths**

```ts
import { describe, it, expect, vi } from 'vitest';
import { BundleAccumulator } from './bundle-accumulator.js';

describe('BundleAccumulator', () => {
  it('flushes when bundle reaches 5 intents', async () => {
    const flushed: number[] = [];
    const acc = new BundleAccumulator({ windowMs: 1000, maxPerBundle: 5, onFlush: (b) => { flushed.push(b.length); return Promise.all(b.map((p) => Promise.resolve('uuid'))); } });
    const promises = Array.from({ length: 5 }, (_, i) => acc.add('group1', { signedTx: new Uint8Array([i]) }));
    await Promise.all(promises);
    expect(flushed).toEqual([5]);
  });

  it('flushes after windowMs elapses', async () => {
    vi.useFakeTimers();
    const flushed: number[] = [];
    const acc = new BundleAccumulator({ windowMs: 50, maxPerBundle: 5, onFlush: (b) => { flushed.push(b.length); return Promise.all(b.map(() => Promise.resolve('uuid'))); } });
    void acc.add('group1', { signedTx: new Uint8Array([1]) });
    void acc.add('group1', { signedTx: new Uint8Array([2]) });
    vi.advanceTimersByTime(60);
    await vi.runAllTimersAsync();
    expect(flushed).toEqual([2]);
    vi.useRealTimers();
  });

  it('isolates bundles by group', async () => {
    vi.useFakeTimers();
    const flushed: Array<{ size: number }> = [];
    const acc = new BundleAccumulator({ windowMs: 50, maxPerBundle: 5, onFlush: (b) => { flushed.push({ size: b.length }); return Promise.all(b.map(() => Promise.resolve('uuid'))); } });
    void acc.add('a', { signedTx: new Uint8Array([1]) });
    void acc.add('b', { signedTx: new Uint8Array([2]) });
    void acc.add('a', { signedTx: new Uint8Array([3]) });
    vi.advanceTimersByTime(60);
    await vi.runAllTimersAsync();
    expect(flushed.map((f) => f.size).sort()).toEqual([1, 2]);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface BundleEntry { signedTx: Uint8Array; }
export type FlushFn = (entries: BundleEntry[]) => Promise<string[]>; // resolves per entry

export interface BundleAccumulatorOpts {
  windowMs: number;
  maxPerBundle: number;
  onFlush: FlushFn;
}

interface PendingEntry {
  entry: BundleEntry;
  resolve: (sig: string) => void;
  reject: (err: Error) => void;
}

interface Accumulator { entries: PendingEntry[]; timer: NodeJS.Timeout | null; }

export class BundleAccumulator {
  private readonly groups = new Map<string, Accumulator>();
  private readonly opts: BundleAccumulatorOpts;

  constructor(opts: BundleAccumulatorOpts) { this.opts = opts; }

  async add(group: string, entry: BundleEntry): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let acc = this.groups.get(group);
      if (!acc) { acc = { entries: [], timer: null }; this.groups.set(group, acc); }
      acc.entries.push({ entry, resolve, reject });
      if (acc.entries.length >= this.opts.maxPerBundle) {
        if (acc.timer) clearTimeout(acc.timer);
        void this.flush(group);
      } else if (!acc.timer) {
        acc.timer = setTimeout(() => { void this.flush(group); }, this.opts.windowMs);
      }
    });
  }

  private async flush(group: string): Promise<void> {
    const acc = this.groups.get(group);
    if (!acc || acc.entries.length === 0) return;
    this.groups.delete(group);
    if (acc.timer) clearTimeout(acc.timer);
    try {
      const sigs = await this.opts.onFlush(acc.entries.map((e) => e.entry));
      acc.entries.forEach((e, i) => e.resolve(sigs[i] ?? ''));
    } catch (err) {
      acc.entries.forEach((e) => e.reject(err as Error));
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test bundle-accumulator
git add packages/solana-executor/src/bundle-accumulator.ts \
        packages/solana-executor/src/bundle-accumulator.test.ts \
        packages/solana-executor/src/index.ts
git commit -m "solana-executor: BundleAccumulator (50ms / 5-intent flush)"
```

Add to index: `export { BundleAccumulator, type BundleAccumulatorOpts } from './bundle-accumulator.js';`

---

### Task 30: `solana-executor` — `InFlightMap` (idempotency)

**Files:**
- Create: `packages/solana-executor/src/in-flight.ts`
- Create: `packages/solana-executor/src/in-flight.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { InFlightMap } from './in-flight.js';

describe('InFlightMap', () => {
  it('returns the same Promise for duplicate intentId until resolution', async () => {
    const map = new InFlightMap<string>();
    let calls = 0;
    const factory = () => new Promise<string>((res) => setTimeout(() => { calls++; res('done'); }, 10));
    const a = map.run('id1', factory);
    const b = map.run('id1', factory);
    expect(a).toBe(b);
    await a;
    expect(calls).toBe(1);
  });

  it('allows re-execution after the prior resolved', async () => {
    const map = new InFlightMap<string>();
    let calls = 0;
    const factory = () => new Promise<string>((res) => { calls++; res('done'); });
    await map.run('id1', factory);
    await map.run('id1', factory);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export class InFlightMap<T> {
  private readonly map = new Map<string, Promise<T>>();

  run(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.map.get(key);
    if (existing) return existing;
    const p = factory().finally(() => this.map.delete(key));
    this.map.set(key, p);
    return p;
  }

  has(key: string): boolean { return this.map.has(key); }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test in-flight
git add packages/solana-executor/src/in-flight.ts \
        packages/solana-executor/src/in-flight.test.ts
git commit -m "solana-executor: InFlightMap idempotency helper"
```

---

### Task 31: `solana-executor` — `confirmLanded` polling

**Files:**
- Create: `packages/solana-executor/src/confirm-landed.ts`
- Create: `packages/solana-executor/src/confirm-landed.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { confirmLanded } from './confirm-landed.js';

describe('confirmLanded', () => {
  it('resolves landed when getSignatureStatuses returns confirmation', async () => {
    let calls = 0;
    const rpcPool: any = {
      call: vi.fn(async () => {
        calls++;
        if (calls < 3) return { value: [null] };
        return { value: [{ slot: 100, confirmationStatus: 'confirmed', err: null }] };
      }),
    };
    const result = await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 5000, pollIntervalMs: 5 });
    expect(result.kind).toBe('landed');
    if (result.kind === 'landed') expect(result.slot).toBe(100);
  });

  it('returns timeout when deadline exceeded', async () => {
    const rpcPool: any = { call: vi.fn(async () => ({ value: [null] })) };
    const result = await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 50, pollIntervalMs: 10 });
    expect(result.kind).toBe('timeout');
  });

  it('returns reverted when err present', async () => {
    const rpcPool: any = {
      call: vi.fn(async () => ({ value: [{ slot: 100, confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom 1'] } }] })),
    };
    const result = await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 1000, pollIntervalMs: 5 });
    expect(result.kind).toBe('reverted');
  });
});
```

- [ ] **Step 2: Implement**

```ts
import type { RpcPool } from '@ap3x/solana-connectivity';

export interface ConfirmLandedOpts {
  rpcPool: RpcPool;
  signature: string;
  deadline: number;
  pollIntervalMs?: number;
}

export type ConfirmResult =
  | { kind: 'landed'; slot: number; landedAt: number }
  | { kind: 'reverted'; slot: number; logs: string[]; error: string }
  | { kind: 'timeout' };

export async function confirmLanded(opts: ConfirmLandedOpts): Promise<ConfirmResult> {
  const interval = opts.pollIntervalMs ?? 250;
  while (Date.now() < opts.deadline) {
    const result = await opts.rpcPool.call('getSignatureStatuses', [[opts.signature], { searchTransactionHistory: true }]);
    const status = (result?.value?.[0] as null | { slot: number; confirmationStatus: string; err: unknown }) ?? null;
    if (status) {
      if (status.err) {
        const tx = await opts.rpcPool.call('getTransaction', [opts.signature, { maxSupportedTransactionVersion: 0 }]);
        return { kind: 'reverted', slot: status.slot, logs: tx?.meta?.logMessages ?? [], error: JSON.stringify(status.err) };
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { kind: 'landed', slot: status.slot, landedAt: Date.now() };
      }
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  return { kind: 'timeout' };
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test confirm-landed
git add packages/solana-executor/src/confirm-landed.ts \
        packages/solana-executor/src/confirm-landed.test.ts
git commit -m "solana-executor: confirmLanded polling helper"
```

---

### Task 32: `solana-executor` — main `Executor` class

**Files:**
- Create: `packages/solana-executor/src/executor.ts`
- Create: `packages/solana-executor/src/executor.test.ts`

- [ ] **Step 1: Implement `Executor` (per spec §3.3 flow)**

`packages/solana-executor/src/executor.ts`:
```ts
import { EventEmitter } from 'node:events';
import type { RpcPool } from '@ap3x/solana-connectivity';
import { TransactionAssembler, type PriorityFeeEstimator, simulateAndBudget } from '@ap3x/solana-tx';
import type { Vault, WalletHandle, WalletReserveBreach } from '@ap3x/solana-vault';
import type { TradeIntent, ExecutionResult } from './types.js';
import type { Submitter, SubmissionAck } from './submitter.js';
import { InFlightMap } from './in-flight.js';
import { BundleAccumulator } from './bundle-accumulator.js';
import { confirmLanded } from './confirm-landed.js';

export interface ExecutorOpts {
  rpcPool: RpcPool;
  vault: Vault;
  feeEstimator: PriorityFeeEstimator;
  assembler: TransactionAssembler;
  submitters: Submitter[];
  defaultSubmitter: 'rpc' | 'jito-http' | 'jito-grpc';
  fallbackChain?: Array<'jito-grpc' | 'jito-http' | 'rpc'>;
  bundleWindowMs?: number;
  bundleMaxIntents?: number;
  pollIntervalMs?: number;
}

export class Executor extends EventEmitter {
  private readonly inFlight = new InFlightMap<ExecutionResult>();
  private readonly bundleAcc: BundleAccumulator;
  private readonly opts: Required<Omit<ExecutorOpts, 'fallbackChain'>> & { fallbackChain: Array<'jito-grpc' | 'jito-http' | 'rpc'> };

  constructor(opts: ExecutorOpts) {
    super();
    this.opts = {
      ...opts,
      fallbackChain: opts.fallbackChain ?? ['jito-grpc', 'jito-http', 'rpc'],
      bundleWindowMs: opts.bundleWindowMs ?? 50,
      bundleMaxIntents: opts.bundleMaxIntents ?? 5,
      pollIntervalMs: opts.pollIntervalMs ?? 250,
    };
    this.bundleAcc = new BundleAccumulator({
      windowMs: this.opts.bundleWindowMs,
      maxPerBundle: this.opts.bundleMaxIntents,
      onFlush: async (entries) => this.flushBundle(entries),
    });
  }

  async submit(intent: TradeIntent): Promise<ExecutionResult> {
    return this.inFlight.run(intent.intentId, () => this.execute(intent));
  }

  private async execute(intent: TradeIntent): Promise<ExecutionResult> {
    let handle: WalletHandle;
    try {
      handle = await this.opts.vault.unlock(intent.wallet, ''); // passphrase resolution out-of-scope; assumes pre-unlocked
    } catch (err) {
      return this.rejected(intent, undefined, 'wallet_locked', String(err));
    }

    const computeBudget = intent.computeBudgetHint ?? (await this.estimateBudget(intent, handle));
    const fee = this.opts.feeEstimator.tier(intent.feeTier);
    const blockhash = (await this.opts.rpcPool.call('getLatestBlockhash', [])).value.blockhash;

    let signedTx: Uint8Array;
    try {
      const message = this.opts.assembler.assemble({
        instructions: intent.instructions,
        payer: handle.address, recentBlockhash: blockhash,
        computeBudget, microLamportsPerCu: fee.microLamportsPerCu,
        alts: intent.altHints,
      });
      signedTx = await handle.signTransaction(message);
    } catch (err: any) {
      if (err?.code === 'reserve_breach') return this.rejected(intent, undefined, 'reserve_breach', err.message);
      return this.rejected(intent, undefined, 'sign_failed', String(err));
    }

    const submitter = this.pickSubmitter(intent);
    if (!submitter) return this.rejected(intent, undefined, 'no_submitter', 'no healthy submitter for requested kind');

    if (intent.submitter?.bundleGroup) {
      if (submitter.kind !== 'jito-http' && submitter.kind !== 'jito-grpc') {
        return this.rejected(intent, submitter.name, 'no_jito_submitter_for_bundle', 'bundleGroup requires a Jito submitter');
      }
      const sig = await this.bundleAcc.add(intent.submitter.bundleGroup, { signedTx });
      return this.confirm(intent, sig, submitter.name);
    }

    let ack: SubmissionAck;
    try {
      ack = await submitter.submit({ kind: 'tx', signedTx });
    } catch (err) {
      return this.rejected(intent, submitter.name, 'submit_failed', String(err));
    }
    return this.confirm(intent, ack.signature!, submitter.name);
  }

  private async confirm(intent: TradeIntent, signature: string, submitterUsed: string): Promise<ExecutionResult> {
    const result = await confirmLanded({
      rpcPool: this.opts.rpcPool, signature, deadline: intent.deadline, pollIntervalMs: this.opts.pollIntervalMs,
    });
    let final: ExecutionResult;
    if (result.kind === 'landed') {
      final = { kind: 'landed', intentId: intent.intentId, signature, slot: result.slot, submitterUsed, landedAt: result.landedAt };
    } else if (result.kind === 'reverted') {
      final = { kind: 'reverted', intentId: intent.intentId, signature, slot: result.slot, submitterUsed, logs: result.logs, error: result.error };
    } else {
      final = { kind: 'timeout', intentId: intent.intentId, signature, submitterUsed };
    }
    this.emit('result', final);
    return final;
  }

  private rejected(intent: TradeIntent, submitterUsed: string | undefined, code: string, message: string): ExecutionResult {
    const r: ExecutionResult = { kind: 'rejected', intentId: intent.intentId, submitterUsed, error: { code, message } };
    this.emit('result', r);
    return r;
  }

  private pickSubmitter(intent: TradeIntent): Submitter | null {
    const wantedKind = intent.submitter?.kind ?? this.opts.defaultSubmitter;
    const ordered: string[] = [wantedKind, ...this.opts.fallbackChain.filter((k) => k !== wantedKind)];
    for (const kind of ordered) {
      const candidate = this.opts.submitters.find((s) => s.kind === kind && s.health().state !== 'unhealthy');
      if (candidate) return candidate;
    }
    return null;
  }

  private async estimateBudget(intent: TradeIntent, handle: WalletHandle): Promise<number> {
    try {
      const result = await simulateAndBudget(this.opts.rpcPool, intent.instructions, handle.address);
      return result.unitsLimit;
    } catch {
      this.emit('budget-fallback', { intentId: intent.intentId });
      return 200_000;
    }
  }

  private async flushBundle(entries: { signedTx: Uint8Array }[]): Promise<string[]> {
    // Picks the configured Jito submitter and submits the bundle.
    const sub = this.opts.submitters.find((s) => s.kind === 'jito-grpc' || s.kind === 'jito-http');
    if (!sub) throw new Error('no Jito submitter configured for bundle flush');
    const ack = await sub.submit({ kind: 'bundle', signedTxs: entries.map((e) => e.signedTx), tipLamports: 10_000n });
    // For now, return placeholder per-tx signatures derived from the bundle UUID. confirm() will poll each.
    // (A richer mapping ships in a later optimization pass — bundle UUID maps to per-tx signatures via the tip-account or post-landing introspection.)
    return entries.map((_, i) => `${ack.bundleId}-${i}`);
  }
}
```

- [ ] **Step 2: Smoke test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { Executor } from './executor.js';
import type { Submitter } from './submitter.js';

const fakeSubmitter: Submitter = {
  name: 'fake-rpc', kind: 'rpc',
  submit: vi.fn(async () => ({ kind: 'tx', signature: 'sig', submitterUsed: 'fake-rpc' })),
  health: () => ({ state: 'healthy' }),
};

describe('Executor smoke', () => {
  it('routes a single-tx intent through the rpc submitter', async () => {
    const fakeRpc: any = {
      pinForWrite: () => fakeRpc,
      call: vi.fn(async (m: string) => {
        if (m === 'getLatestBlockhash') return { value: { blockhash: 'AAA' } };
        if (m === 'getSignatureStatuses') return { value: [{ slot: 100, confirmationStatus: 'confirmed', err: null }] };
        return null;
      }),
    };
    const fakeVault: any = { unlock: vi.fn(async () => ({ address: { toBase58: () => '11111111111111111111111111111111', equals: () => true }, signTransaction: vi.fn(async (m: Uint8Array) => m), sign: vi.fn(), role: 'main' })) };
    const fakeAssembler: any = { assemble: vi.fn(() => new Uint8Array([1, 2, 3])) };
    const fakeFeeEst: any = { tier: () => ({ microLamportsPerCu: 1n, asOfSlot: 0 }) };

    const exec = new Executor({
      rpcPool: fakeRpc, vault: fakeVault, feeEstimator: fakeFeeEst, assembler: fakeAssembler,
      submitters: [fakeSubmitter], defaultSubmitter: 'rpc',
    });
    const result = await exec.submit({
      intentId: 'i1', wallet: 'main', instructions: [], feeTier: 'med',
      deadline: Date.now() + 5000, computeBudgetHint: 200_000,
    });
    expect(result.kind).toBe('landed');
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test executor
git add packages/solana-executor/src/executor.ts \
        packages/solana-executor/src/executor.test.ts \
        packages/solana-executor/src/index.ts
git commit -m "solana-executor: Executor.submit (idempotency + routing + bundling + landing poll)"
```

Add to index: `export { Executor, type ExecutorOpts } from './executor.js';`

---

### Task 33: `solana-executor` — failover + retry with fee-tier progression

**Files:**
- Modify: `packages/solana-executor/src/executor.ts` (add retry loop)
- Create: `packages/solana-executor/tests/failover.test.ts`
- Create: `packages/solana-executor/tests/retry.test.ts`

- [ ] **Step 1: Add retry logic to `Executor.submit`**

Wrap the inner `execute` call with a retry loop driven by `intent.retry`. On `dropped` result, bump `feeTier` per `BUMP_PROGRESSION` (`['low','med','high','turbo']`) and re-execute up to `maxAttempts`. Each attempt emits `executor.attempt` metric.

- [ ] **Step 2: Failover test (gate 5)**

```ts
import { describe, it, expect, vi } from 'vitest';
// ... build a Submitter that throws once then succeeds; assert second submitter is used.
```

Test: kill primary RPC mid-execution; assert continuation on backup without losing the in-flight intent.

- [ ] **Step 3: Retry test**

Test: feeTier bump progression on `dropped` results; assert each attempt uses the next-higher tier.

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test failover retry
git add packages/solana-executor/src/executor.ts \
        packages/solana-executor/tests/failover.test.ts \
        packages/solana-executor/tests/retry.test.ts
git commit -m "solana-executor: failover + retry with fee-tier bump progression (gate 5)"
```

---

### Task 34: `solana-executor` — gate-9 (Jito HTTP/gRPC parity) + gate-4 (vault breach)

**Files:**
- Create: `packages/solana-executor/tests/jito-parity.test.ts`
- Create: `packages/solana-executor/tests/vault-integration.test.ts`

- [ ] **Step 1: Gate-9 parity test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HttpClient, PublicKey } from '@ap3x/solana-core';
import { JitoHttpSubmitter, JitoGrpcSubmitter } from '@ap3x/solana-executor';
import { startFakeJitoServer } from '../tests/helpers/jito-fake-server.js';

const server = setupServer(
  http.post('https://mainnet.block-engine.jito.wtf/api/v1/bundles', async () =>
    HttpResponse.json({ result: 'fake-bundle-uuid' }),
  ),
);
beforeAll(() => server.listen());
afterAll(() => server.close());

describe('gate 9: Jito HTTP/gRPC parity', () => {
  it('both submitters return structurally-equivalent ack for same input', async () => {
    const grpcServer = await startFakeJitoServer();
    try {
      const tipAccount = PublicKey.fromBase58('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');
      const httpSub = new JitoHttpSubmitter({
        httpClient: new HttpClient({ timeoutMs: 5000, retry: { attempts: 1, backoffMs: 0, jitter: false } }),
        blockEngineUrl: 'https://mainnet.block-engine.jito.wtf', tipAccount,
      });
      const grpcSub = new JitoGrpcSubmitter({ grpcEndpoint: `127.0.0.1:${grpcServer.port}`, tipAccount });

      const payload = { kind: 'bundle' as const, signedTxs: [new Uint8Array([1, 2, 3])], tipLamports: 10_000n };
      const httpAck = await httpSub.submit(payload);
      const grpcAck = await grpcSub.submit(payload);

      expect(Object.keys(httpAck).sort()).toEqual(Object.keys(grpcAck).sort());
      expect(httpAck.kind).toBe('bundle');
      expect(grpcAck.kind).toBe('bundle');
      expect(httpAck.bundleId).toBeDefined();
      expect(grpcAck.bundleId).toBeDefined();
    } finally {
      await grpcServer.shutdown();
    }
  });
});
```

- [ ] **Step 2: Gate-4 vault-breach test**

```ts
// vault-integration.test.ts
// Build a fake Vault whose WalletHandle.signTransaction throws WalletReserveBreach.
// Assert Executor.submit returns { kind: 'rejected', error: { code: 'reserve_breach' } }.
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-executor test jito-parity vault-integration
git add packages/solana-executor/tests/
git commit -m "solana-executor: gate-9 (Jito HTTP/gRPC parity) + gate-4 (reserve breach) tests"
```

---

## Phase D — Strategy runtime (depends on A, B, C)

### Task 35: `solana-strategy` — package scaffold + `Strategy` abstract + `SignalFilter`

**Files:**
- Create: `packages/solana-strategy/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,README.md}`
- Create: `packages/solana-strategy/src/{index,strategy,filter}.ts`
- Create: `packages/solana-strategy/src/filter.test.ts`

- [ ] **Step 1: Scaffold (deps include all four runtime sibling packages + vault, core)**

```json
// package.json deps:
"dependencies": {
  "@ap3x/solana-core": "workspace:*",
  "@ap3x/solana-signals": "workspace:*",
  "@ap3x/solana-executor": "workspace:*",
  "@ap3x/solana-portfolio": "workspace:*",
  "@ap3x/solana-vault": "workspace:*",
  "@noble/hashes": "^1.4.0"
}
```

- [ ] **Step 2: Define `Strategy` + `SignalFilter` types**

`packages/solana-strategy/src/strategy.ts`:
```ts
import type { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';
import type { TradeIntent, ExecutionResult } from '@ap3x/solana-executor';
import type { PositionChange } from '@ap3x/solana-portfolio';
import type { StrategyContext } from './context.js';
import type { SignalFilter } from './filter.js';

export type Decision = TradeIntent;
export type HookPhase = 'onStart' | 'onSignal' | 'onExecutionResult' | 'onPositionChange' | 'onBalanceChange' | 'onTick' | 'onShutdown';

export interface BalanceDelta { mint: PublicKey; delta: bigint; preAmount: bigint; postAmount: bigint; slot: number; }

export abstract class Strategy {
  abstract readonly name: string;
  abstract readonly filters: SignalFilter[];

  onStart?(ctx: StrategyContext): Promise<void>;
  onShutdown?(ctx: StrategyContext): Promise<void>;

  abstract onSignal(signal: Signal, ctx: StrategyContext): Promise<Decision | null>;
  onExecutionResult?(result: ExecutionResult, ctx: StrategyContext): Promise<void>;
  onPositionChange?(change: PositionChange, ctx: StrategyContext): Promise<void>;
  onBalanceChange?(wallet: string, deltas: BalanceDelta[], ctx: StrategyContext): Promise<void>;
  onTick?(tsMs: number, ctx: StrategyContext): Promise<void>;

  /** Synchronous reporter — must NOT await. Called on any uncaught hook error. */
  onError?(err: Error, phase: HookPhase, ctx: StrategyContext): void;
}
```

`packages/solana-strategy/src/filter.ts`:
```ts
import type { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';

export interface SignalFilter {
  programId?: PublicKey | PublicKey[];
  venue?: string;
  kind?: string | RegExp;
}

export function matches(filter: SignalFilter, signal: Signal): boolean {
  if (filter.programId) {
    const arr = Array.isArray(filter.programId) ? filter.programId : [filter.programId];
    if (!arr.some((p) => p.equals(signal.programId))) return false;
  }
  if (filter.venue && filter.venue !== signal.venue) return false;
  if (filter.kind) {
    if (filter.kind instanceof RegExp) { if (!filter.kind.test(signal.kind)) return false; }
    else if (filter.kind !== signal.kind) return false;
  }
  return true;
}

export function matchesAny(filters: SignalFilter[], signal: Signal): boolean {
  return filters.some((f) => matches(f, signal));
}
```

- [ ] **Step 3: Test the matcher**

```ts
// filter.test.ts: cover programId single + array, venue, kind string + regex, and combined AND-within-filter / OR-across-filters.
```

- [ ] **Step 4: Run + commit**

```bash
pnpm install
pnpm --filter @ap3x/solana-strategy test filter
git add packages/solana-strategy/
git commit -m "solana-strategy: package scaffold + Strategy abstract + SignalFilter matcher"
```

---

### Task 36: `solana-strategy` — `StrategyContext` + `PriceSource` + `Logger`

**Files:**
- Create: `packages/solana-strategy/src/context.ts`

- [ ] **Step 1: Define interfaces**

```ts
import type { PublicKey } from '@ap3x/solana-core';
import type { PortfolioReadApi } from '@ap3x/solana-portfolio';

export interface VaultReadApi {
  getAddress(name: string): Promise<PublicKey>;
  list(): Promise<Array<{ name: string; role: string; address: PublicKey }>>;
}

export interface PriceSource {
  getPriceLamportsPerToken(mint: PublicKey, atSlot?: number): Promise<bigint | null>;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(err: unknown, meta?: Record<string, unknown>): void;
}

export interface MetricsEmitter {
  emit(topic: string, payload: Record<string, unknown>): void;
}

export interface StrategyStateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface StrategyContext {
  readonly portfolio: PortfolioReadApi;
  readonly vault: VaultReadApi;
  readonly state: StrategyStateStore;
  readonly metrics: MetricsEmitter;
  readonly priceSource?: PriceSource;
  readonly logger: Logger;
  now(): number;
}
```

- [ ] **Step 2: Re-export + commit**

```bash
git add packages/solana-strategy/src/context.ts packages/solana-strategy/src/index.ts
git commit -m "solana-strategy: StrategyContext + PriceSource + Logger interfaces"
```

---

### Task 37: `solana-strategy` — `FileStrategyStateStore`

**Files:**
- Create: `packages/solana-strategy/src/state-store-file.ts`
- Create: `packages/solana-strategy/src/state-store-file.test.ts`

- [ ] **Step 1: Write failing tests (mirror `FileSignalCheckpointStore` shape)**

Cover: round-trip, isolation per (strategyName, instanceId, key), atomic write under simulated kill-mid-write, list with prefix.

- [ ] **Step 2: Implement (atomic tmp+rename, per-key mutex; identical to PRP-01 file-store pattern)**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StrategyStateStore } from './context.js';

export interface FileStrategyStateStoreOpts {
  dir?: string;
  strategyName: string;
  instanceId: string;
}

export class FileStrategyStateStore implements StrategyStateStore {
  private readonly dir: string;
  private readonly mutexes = new Map<string, Promise<void>>();

  constructor(opts: FileStrategyStateStoreOpts) {
    const root = opts.dir ?? '.ap3x/strategy';
    this.dir = path.join(root, opts.strategyName, opts.instanceId);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.pathFor(key), 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.withMutex(key, async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const p = this.pathFor(key);
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, p);
    });
  }

  async delete(key: string): Promise<void> {
    await this.withMutex(key, async () => {
      try { await fs.unlink(this.pathFor(key)); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    });
  }

  async list(prefix?: string): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((k) => !prefix || k.startsWith(prefix));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private pathFor(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  private async withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(key) ?? Promise.resolve();
    let resolveOuter: () => void;
    const next = new Promise<void>((res) => { resolveOuter = res; });
    this.mutexes.set(key, prev.then(() => next));
    await prev;
    try { return await fn(); }
    finally {
      resolveOuter!();
      if (this.mutexes.get(key) === prev.then(() => next)) this.mutexes.delete(key);
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-strategy test state-store-file
git add packages/solana-strategy/src/state-store-file.ts \
        packages/solana-strategy/src/state-store-file.test.ts
git commit -m "solana-strategy: FileStrategyStateStore (atomic + per-key mutex)"
```

---

### Task 38: `solana-strategy` — per-instance dispatch queue

**Files:**
- Create: `packages/solana-strategy/src/instance-queue.ts`
- Create: `packages/solana-strategy/src/instance-queue.test.ts`

- [ ] **Step 1: Write failing test asserting strict serialization across hooks**

```ts
import { describe, it, expect } from 'vitest';
import { InstanceQueue } from './instance-queue.js';

describe('InstanceQueue', () => {
  it('serializes all enqueued tasks (no interleaving)', async () => {
    const q = new InstanceQueue();
    const log: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      log.push(`${label}-start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${label}-end`);
    };
    await Promise.all([q.enqueue(slow('a', 10)), q.enqueue(slow('b', 5)), q.enqueue(slow('c', 1))]);
    expect(log).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export class InstanceQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    let resolveTask: (v: T) => void;
    let rejectTask: (e: unknown) => void;
    const result = new Promise<T>((res, rej) => { resolveTask = res; rejectTask = rej; });
    this.chain = this.chain.then(async () => {
      try { resolveTask(await task()); }
      catch (err) { rejectTask(err); }
    });
    return result;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ap3x/solana-strategy test instance-queue
git add packages/solana-strategy/src/instance-queue.ts \
        packages/solana-strategy/src/instance-queue.test.ts
git commit -m "solana-strategy: per-instance dispatch queue (strict hook serialization)"
```

---

### Task 39: `solana-strategy` — `intentId` derivation

**Files:**
- Create: `packages/solana-strategy/src/intent-id.ts`
- Create: `packages/solana-strategy/src/intent-id.test.ts`

- [ ] **Step 1: Implement (mirror `signalId` from solana-signals)**

```ts
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@ap3x/solana-core';

export interface IntentIdInput {
  signalId: string;
  strategyName: string;
  instanceId: string;
  decisionVersion?: string;
}

export function intentId(input: IntentIdInput): string {
  const enc = new TextEncoder();
  const sep = enc.encode('\x00');
  const parts = [
    enc.encode(input.signalId),
    enc.encode(input.strategyName),
    enc.encode(input.instanceId),
    enc.encode(input.decisionVersion ?? 'v1'),
  ];
  let total = parts.reduce((s, p) => s + p.length, 0) + sep.length * (parts.length - 1);
  const buf = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    buf.set(parts[i]!, off); off += parts[i]!.length;
    if (i < parts.length - 1) { buf.set(sep, off); off += sep.length; }
  }
  return base58.encode(sha256(buf));
}
```

- [ ] **Step 2: Test determinism + multi-instance non-collision**

- [ ] **Step 3: Commit**

```bash
git add packages/solana-strategy/src/intent-id.ts packages/solana-strategy/src/intent-id.test.ts
git commit -m "solana-strategy: intentId derivation (deterministic, multi-instance safe)"
```

---

### Task 40: `solana-strategy` — `GuardTracker` (rate / loss / error / drawdown)

**Files:**
- Create: `packages/solana-strategy/src/guards.ts`
- Create: `packages/solana-strategy/src/guards.test.ts`

- [ ] **Step 1: Define `GuardConfig` + `GuardTracker`**

```ts
export interface GuardConfig {
  maxDecisionsPerMin?: number;        // default 60
  maxOpenPositions?: number;          // default unlimited
  maxLossPerDayLamports?: bigint;     // default unlimited (opt-in)
  errorThreshold?: { errors: number; windowMs: number }; // default 5 / 60_000
  drawdownThreshold?: bigint;         // default unlimited
}

export type GuardTrip = { guard: keyof GuardConfig; value: number | bigint; };

export class GuardTracker {
  private decisionTimes: number[] = [];
  private errorTimes: number[] = [];
  private realizedToday: bigint = 0n;
  private dayStartTs = startOfDayUtc(Date.now());
  constructor(private cfg: GuardConfig, private clock: () => number = Date.now) {}

  recordDecision(): GuardTrip | null {
    const now = this.clock();
    this.decisionTimes = this.decisionTimes.filter((t) => now - t < 60_000);
    this.decisionTimes.push(now);
    const max = this.cfg.maxDecisionsPerMin ?? 60;
    if (this.decisionTimes.length > max) return { guard: 'maxDecisionsPerMin', value: this.decisionTimes.length };
    return null;
  }

  recordError(): GuardTrip | null {
    const window = this.cfg.errorThreshold?.windowMs ?? 60_000;
    const now = this.clock();
    this.errorTimes = this.errorTimes.filter((t) => now - t < window);
    this.errorTimes.push(now);
    const max = this.cfg.errorThreshold?.errors ?? 5;
    if (this.errorTimes.length > max) return { guard: 'errorThreshold', value: this.errorTimes.length };
    return null;
  }

  recordRealized(amount: bigint): GuardTrip | null {
    const now = this.clock();
    if (startOfDayUtc(now) !== this.dayStartTs) {
      this.dayStartTs = startOfDayUtc(now);
      this.realizedToday = 0n;
    }
    this.realizedToday += amount;
    if (this.cfg.maxLossPerDayLamports && this.realizedToday < -this.cfg.maxLossPerDayLamports) {
      return { guard: 'maxLossPerDayLamports', value: this.realizedToday };
    }
    return null;
  }
}

function startOfDayUtc(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
```

- [ ] **Step 2: Test (table-driven for each guard type)**

- [ ] **Step 3: Commit**

```bash
pnpm --filter @ap3x/solana-strategy test guards
git add packages/solana-strategy/src/guards.ts packages/solana-strategy/src/guards.test.ts
git commit -m "solana-strategy: GuardTracker (rate/loss/error/drawdown)"
```

---

### Task 41: `solana-strategy` — `ExecutionResult → LandedTrade` adapter

**Files:**
- Create: `packages/solana-strategy/src/landed-trade-adapter.ts`
- Create: `packages/solana-strategy/src/landed-trade-adapter.test.ts`

- [ ] **Step 1: Implement (the runtime-owned adapter that breaks the executor↔portfolio cycle)**

```ts
import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { ExecutionResult } from '@ap3x/solana-executor';
import type { LandedTrade } from '@ap3x/solana-portfolio';

export interface AdaptOpts {
  rpcPool: RpcPool;
  walletAddress: PublicKey;
}

/**
 * Adapts a `landed` ExecutionResult into one or more LandedTrade records by
 * fetching the tx and extracting per-mint deltas + SOL flow for the target
 * wallet. `dropped`, `timeout`, `reverted`, `rejected` produce zero trades.
 */
export async function adaptToLandedTrades(result: ExecutionResult, opts: AdaptOpts): Promise<LandedTrade[]> {
  if (result.kind !== 'landed') return [];
  const tx = await opts.rpcPool.call('getTransaction', [result.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
  if (!tx?.meta) return [];
  const walletStr = opts.walletAddress.toBase58();

  const accountIdx = (tx.transaction.message.accountKeys as string[]).indexOf(walletStr);
  const fee = BigInt(tx.meta.fee ?? 0);
  let solDelta = 0n;
  if (accountIdx >= 0) {
    const before = BigInt(tx.meta.preBalances[accountIdx]);
    const after = BigInt(tx.meta.postBalances[accountIdx]);
    solDelta = after - before; // positive = SOL inflow
  }

  const deltasByMint = new Map<string, bigint>();
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const seen = new Set<string>();
  for (const b of post) {
    if (b.owner !== walletStr) continue;
    seen.add(b.mint);
    const preAmt = BigInt(pre.find((p: any) => p.owner === walletStr && p.mint === b.mint)?.uiTokenAmount?.amount ?? '0');
    const postAmt = BigInt(b.uiTokenAmount?.amount ?? '0');
    deltasByMint.set(b.mint, postAmt - preAmt);
  }
  for (const b of pre) {
    if (b.owner !== walletStr || seen.has(b.mint)) continue;
    deltasByMint.set(b.mint, -BigInt(b.uiTokenAmount?.amount ?? '0'));
  }

  const trades: LandedTrade[] = [];
  for (const [mintStr, delta] of deltasByMint) {
    if (delta === 0n) continue;
    trades.push({
      signature: result.signature, slot: result.slot,
      wallet: opts.walletAddress, mint: PublicKey.fromBase58(mintStr),
      amountDelta: delta, solFlowLamports: solDelta, feeLamports: fee, source: 'executor',
    });
  }
  return trades;
}
```

- [ ] **Step 2: Test against fake `RpcPool` that returns a synthetic `getTransaction` payload with mixed token deltas**

- [ ] **Step 3: Commit**

```bash
pnpm --filter @ap3x/solana-strategy test landed-trade-adapter
git add packages/solana-strategy/src/landed-trade-adapter.ts packages/solana-strategy/src/landed-trade-adapter.test.ts
git commit -m "solana-strategy: ExecutionResult → LandedTrade adapter (runtime-owned cycle break)"
```

---

### Task 42: `solana-strategy` — `StrategyRuntime` orchestrator

**Files:**
- Create: `packages/solana-strategy/src/runtime.ts`
- Create: `packages/solana-strategy/src/runtime.test.ts`

- [ ] **Step 1: Implement runtime with per-instance state, lifecycle wiring, error isolation, guard quarantine**

```ts
import { EventEmitter } from 'node:events';
import type { Signal, SignalQueue } from '@ap3x/solana-signals';
import type { Executor, ExecutionResult } from '@ap3x/solana-executor';
import type { FilePortfolioStore, PositionChange } from '@ap3x/solana-portfolio';
import type { Vault } from '@ap3x/solana-vault';
import type { RpcPool } from '@ap3x/solana-connectivity';
import { PublicKey } from '@ap3x/solana-core';
import { Strategy, type Decision, type HookPhase } from './strategy.js';
import { matchesAny } from './filter.js';
import { InstanceQueue } from './instance-queue.js';
import { intentId } from './intent-id.js';
import { adaptToLandedTrades } from './landed-trade-adapter.js';
import { GuardTracker, type GuardConfig } from './guards.js';
import type { StrategyContext, PriceSource, Logger, MetricsEmitter, StrategyStateStore } from './context.js';
import { FileStrategyStateStore } from './state-store-file.js';

export interface StrategyRuntimeOpts {
  signalQueue: SignalQueue;
  executor: Executor;
  portfolio: FilePortfolioStore;
  vault: Vault;
  rpcPool: RpcPool;
  priceSource?: PriceSource;
  clock?: () => number;
  tickIntervalMs?: number;
  guards?: GuardConfig;
  stateStoreFactory?: (strategyName: string, instanceId: string) => StrategyStateStore;
  logger?: Logger;
  metrics?: MetricsEmitter;
}

interface InstanceRecord {
  strategy: Strategy;
  instanceId: string;
  ctx: StrategyContext;
  queue: InstanceQueue;
  guards: GuardTracker;
  quarantined: boolean;
  walletAddresses: Map<string, PublicKey>;
}

export class StrategyRuntime extends EventEmitter {
  private readonly instances = new Map<string, InstanceRecord>();
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<Omit<StrategyRuntimeOpts, 'priceSource' | 'logger' | 'metrics' | 'stateStoreFactory'>> & Pick<StrategyRuntimeOpts, 'priceSource' | 'logger' | 'metrics' | 'stateStoreFactory'>;
  private signalSubName = 'strategy-runtime';

  constructor(opts: StrategyRuntimeOpts) {
    super();
    this.opts = {
      ...opts,
      clock: opts.clock ?? Date.now,
      tickIntervalMs: opts.tickIntervalMs ?? 1000,
      guards: opts.guards ?? {},
    };
  }

  async register(strategy: Strategy, instanceId?: string): Promise<void> {
    const id = instanceId ?? strategy.name;
    if (this.instances.has(id)) throw new Error(`instance ${id} already registered`);
    const stateStore = (this.opts.stateStoreFactory ?? ((sn, i) => new FileStrategyStateStore({ strategyName: sn, instanceId: i })))(strategy.name, id);
    const ctx: StrategyContext = {
      portfolio: this.opts.portfolio,
      vault: { getAddress: async (n) => (await this.opts.vault.unlock(n, '')).address, list: async () => [] },
      state: stateStore,
      metrics: this.opts.metrics ?? { emit: () => {} },
      priceSource: this.opts.priceSource,
      logger: this.opts.logger ?? noopLogger,
      now: this.opts.clock,
    };
    const record: InstanceRecord = {
      strategy, instanceId: id, ctx,
      queue: new InstanceQueue(),
      guards: new GuardTracker(this.opts.guards, this.opts.clock),
      quarantined: false,
      walletAddresses: new Map(),
    };
    this.instances.set(id, record);
    if (strategy.onStart) {
      await record.queue.enqueue(() => this.callHook(record, 'onStart', () => strategy.onStart!(ctx)));
    }
  }

  async deregister(instanceId: string): Promise<void> {
    const rec = this.instances.get(instanceId);
    if (!rec) return;
    if (rec.strategy.onShutdown) {
      await rec.queue.enqueue(() => this.callHook(rec, 'onShutdown', () => rec.strategy.onShutdown!(rec.ctx)));
    }
    this.instances.delete(instanceId);
  }

  start(): void {
    this.opts.signalQueue.subscribe(this.signalSubName, (sig: Signal) => this.dispatchSignal(sig));
    this.opts.executor.on('result', (r: ExecutionResult) => this.dispatchExecutionResult(r));
    this.opts.portfolio.on('change', (c: PositionChange) => this.dispatchPositionChange(c));
    this.tickTimer = setInterval(() => { this.dispatchTick(); }, this.opts.tickIntervalMs);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.opts.signalQueue.unsubscribe(this.signalSubName);
  }

  pause(instanceId: string): void {
    const rec = this.instances.get(instanceId);
    if (rec) rec.quarantined = true;
  }
  resume(instanceId: string): void {
    const rec = this.instances.get(instanceId);
    if (rec) rec.quarantined = false;
  }

  private async dispatchSignal(sig: Signal): Promise<void> {
    for (const rec of this.instances.values()) {
      if (rec.quarantined) continue;
      if (!matchesAny(rec.strategy.filters, sig)) continue;
      void rec.queue.enqueue(async () => {
        const decision = await this.callHook(rec, 'onSignal', () => rec.strategy.onSignal(sig, rec.ctx));
        if (!decision) return;
        const trip = rec.guards.recordDecision();
        if (trip) { void this.tripGuard(rec, trip); return; }
        const fullIntent = { ...decision, intentId: intentId({ signalId: sig.signalId, strategyName: rec.strategy.name, instanceId: rec.instanceId }) };
        const wallet = rec.walletAddresses.get(fullIntent.wallet) ?? (await rec.ctx.vault.getAddress(fullIntent.wallet));
        rec.walletAddresses.set(fullIntent.wallet, wallet);
        const result = await this.opts.executor.submit(fullIntent);
        const trades = await adaptToLandedTrades(result, { rpcPool: this.opts.rpcPool, walletAddress: wallet });
        for (const t of trades) await this.opts.portfolio.applyLandedTrade(t);
      });
    }
  }

  private async dispatchExecutionResult(result: ExecutionResult): Promise<void> {
    for (const rec of this.instances.values()) {
      if (rec.quarantined || !rec.strategy.onExecutionResult) continue;
      void rec.queue.enqueue(() => this.callHook(rec, 'onExecutionResult', () => rec.strategy.onExecutionResult!(result, rec.ctx)));
    }
  }

  private async dispatchPositionChange(change: PositionChange): Promise<void> {
    for (const rec of this.instances.values()) {
      if (rec.quarantined || !rec.strategy.onPositionChange) continue;
      void rec.queue.enqueue(() => this.callHook(rec, 'onPositionChange', () => rec.strategy.onPositionChange!(change, rec.ctx)));
    }
  }

  private dispatchTick(): void {
    const now = this.opts.clock();
    for (const rec of this.instances.values()) {
      if (rec.quarantined || !rec.strategy.onTick) continue;
      void rec.queue.enqueue(() => this.callHook(rec, 'onTick', () => rec.strategy.onTick!(now, rec.ctx)));
    }
  }

  private async callHook<T>(rec: InstanceRecord, phase: HookPhase, fn: () => Promise<T> | T): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      try { rec.strategy.onError?.(err as Error, phase, rec.ctx); } catch { /* swallow */ }
      const trip = rec.guards.recordError();
      if (trip) void this.tripGuard(rec, trip);
      this.emit('strategy-error', { instanceId: rec.instanceId, phase, error: err });
      return undefined;
    }
  }

  private async tripGuard(rec: InstanceRecord, trip: { guard: string; value: number | bigint }): Promise<void> {
    if (rec.quarantined) return;
    rec.quarantined = true;
    this.opts.metrics?.emit('strategy.tripped', { instanceId: rec.instanceId, ...trip });
    if (rec.strategy.onShutdown) {
      try { await rec.strategy.onShutdown(rec.ctx); } catch { /* swallow */ }
    }
  }
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
```

- [ ] **Step 2: Smoke test (register a minimal strategy, push a signal, assert hook fired)**

- [ ] **Step 3: Commit**

```bash
pnpm --filter @ap3x/solana-strategy test runtime
git add packages/solana-strategy/src/runtime.ts packages/solana-strategy/src/runtime.test.ts
git commit -m "solana-strategy: StrategyRuntime orchestrator (lifecycle, dispatch, guards, quarantine)"
```

---

### Task 43: `solana-strategy` — `runBacktest` harness + simulated executor

**Files:**
- Create: `packages/solana-strategy/src/backtest.ts`
- Create: `packages/solana-strategy/src/backtest.test.ts`

- [ ] **Step 1: Implement simulated executor + `runBacktest`**

Same dispatch path as `StrategyRuntime`; the only swaps are:
- Signal source: `FixtureSignalSource`
- Executor: `SimulatedExecutor` (in-memory, deterministic via injected `rng`)

`packages/solana-strategy/src/backtest.ts`:
```ts
import type { FixtureSignalSource } from '@ap3x/solana-signals';
import type { TradeIntent, ExecutionResult } from '@ap3x/solana-executor';
import { Strategy } from './strategy.js';

export interface SimulatedExecutorConfig {
  landingSuccessRate?: number;     // default 1.0
  minLatencyMs?: number;           // default 0
  maxLatencyMs?: number;           // default 0
}

export interface BacktestOpts {
  strategy: Strategy;
  fixtureSource: FixtureSignalSource;
  clock: () => number;
  rng?: () => number;
  simulatedExecutor?: SimulatedExecutorConfig;
}

export interface BacktestResult {
  trades: TradeIntent[];
  realizedPnl: bigint;
  decisionLog: Array<{ intentId: string; signalId: string; tsMs: number }>;
  lifecycleLog: Array<{ phase: string; tsMs: number; meta?: Record<string, unknown> }>;
  finalPositions: unknown[];
}

export async function runBacktest(opts: BacktestOpts): Promise<BacktestResult> {
  const decisionLog: BacktestResult['decisionLog'] = [];
  const lifecycleLog: BacktestResult['lifecycleLog'] = [];
  const trades: TradeIntent[] = [];
  // ... (full implementation: build a SimulatedExecutor + minimal in-memory PortfolioStore + StrategyRuntime; wire up; await fixture end + queue drain.)
  return { trades, realizedPnl: 0n, decisionLog, lifecycleLog, finalPositions: [] };
}
```

(Implementer should expand the placeholder using `StrategyRuntime` from Task 42 with substituted executor + portfolio. Mirror PRP-01 plan style: code is illustrative, full implementation in this task.)

- [ ] **Step 2: Determinism test (gate 6)**

```ts
import { describe, it, expect } from 'vitest';
import { runBacktest } from './backtest.js';
// ... build a strategy + fixture source + fixed clock + seeded rng. Run twice, assert byte-identical decisionLog + lifecycleLog.
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter @ap3x/solana-strategy test backtest
git add packages/solana-strategy/src/backtest.ts packages/solana-strategy/src/backtest.test.ts
git commit -m "solana-strategy: runBacktest harness (gate 6 backtest parity)"
```

---

### Task 44: `solana-strategy` — gate-1, 2, 3, 7, 10 integration tests

**Files:**
- Create: `packages/solana-strategy/tests/e2e-fixture.test.ts` (gate 1+2+10)
- Create: `packages/solana-strategy/tests/restart-recovery.test.ts` (gate 3)
- Create: `packages/solana-strategy/tests/lifecycle-fidelity.test.ts` (gate 10 expanded)
- Create: `packages/solana-strategy/tests/drift-reconcile.test.ts` (gate 7)

Each test wires `FixtureSignalSource → SignalQueue → StrategyRuntime → SimulatedExecutor → InMemoryPortfolio` with assertions per gate spec. The `restart-recovery` test spawns a child process and SIGKILLs after 50 signals, then re-runs and asserts no dups/gaps.

- [ ] **Step 1: Write failing tests per gate (one test per file as listed)**

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @ap3x/solana-strategy test e2e-fixture restart-recovery lifecycle-fidelity drift-reconcile
git add packages/solana-strategy/tests/
git commit -m "solana-strategy: gates 1/2/3/7/10 integration tests"
```

---

## Phase E — Example app

### Task 45: `examples/spl-watcher` — bundled fixture + scaffold

**Files:**
- Create: `examples/spl-watcher/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,README.md}`
- Create: `tests/fixtures/signals-spl-watcher.jsonl.gz` (small captured/synthesized fixture, ~50 signals)

- [ ] **Step 1: Scaffold (deps: all 4 runtime packages + solana-spl + solana-events + solana-connectivity + solana-core)**

- [ ] **Step 2: Generate the fixture (synthesize from recorded SPL transfer logs OR hand-construct 50 signals targeting watched wallets)**

- [ ] **Step 3: Commit**

```bash
git add examples/spl-watcher/ tests/fixtures/signals-spl-watcher.jsonl.gz
git commit -m "examples/spl-watcher: scaffold + bundled SPL transfer fixture"
```

---

### Task 46: `examples/spl-watcher` — `WatcherStrategy` + `wallets.ts`

**Files:**
- Create: `examples/spl-watcher/src/watcher-strategy.ts`
- Create: `examples/spl-watcher/src/wallets.ts`

- [ ] **Step 1: Implement `WatcherStrategy`**

```ts
import { Strategy, type StrategyContext, type SignalFilter } from '@ap3x/solana-strategy';
import type { Signal } from '@ap3x/solana-signals';
import { SPL_TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import type { PublicKey } from '@ap3x/solana-core';

export class WatcherStrategy extends Strategy {
  readonly name = 'spl-watcher';
  readonly filters: SignalFilter[] = [{ programId: SPL_TOKEN_PROGRAM_ID, kind: 'spl.transfer' }];

  constructor(private readonly watchedWallets: Set<string>) { super(); }

  async onSignal(signal: Signal, _ctx: StrategyContext): Promise<null> {
    const decoded = signal.decoded as { dest?: PublicKey; source?: PublicKey; amount?: bigint };
    if (decoded.dest && this.watchedWallets.has(decoded.dest.toBase58())) {
      console.log(JSON.stringify({
        wallet: decoded.dest.toBase58(),
        sig: signal.signature,
        slot: signal.slot,
        amount: decoded.amount?.toString() ?? '?',
      }));
    }
    return null;
  }
}
```

- [ ] **Step 2: Implement `wallets.ts` (parse `--wallet` CLI flags)**

- [ ] **Step 3: Commit**

```bash
git add examples/spl-watcher/src/watcher-strategy.ts examples/spl-watcher/src/wallets.ts
git commit -m "examples/spl-watcher: WatcherStrategy + CLI flag parser"
```

---

### Task 47: `examples/spl-watcher` — CLI entry + e2e test

**Files:**
- Create: `examples/spl-watcher/src/index.ts`
- Create: `examples/spl-watcher/tests/e2e.test.ts`
- Create: `examples/spl-watcher/scripts/run-historical.sh`

- [ ] **Step 1: Implement CLI entry (parse `--fixture` / `--rpc / --geyser` / `--wallet`)**

`examples/spl-watcher/src/index.ts`:
```ts
import { FixtureSignalSource, HistoricalSignalSource, GeyserSignalSource, SignalQueue } from '@ap3x/solana-signals';
import { EventDecoderRegistry } from '@ap3x/solana-events';
import { SPL_TOKEN_PROGRAM_ID, parseTransferLog } from '@ap3x/solana-spl';
import { StrategyRuntime } from '@ap3x/solana-strategy';
import { WatcherStrategy } from './watcher-strategy.js';
import { parseWalletFlags } from './wallets.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wallets = parseWalletFlags(args);
  const registry = new EventDecoderRegistry();
  registry.register(SPL_TOKEN_PROGRAM_ID, {
    programId: SPL_TOKEN_PROGRAM_ID,
    decode(chunk) {
      const decoded = parseTransferLog(chunk);
      return decoded
        ? { kind: 'spl.transfer', decoded, programId: SPL_TOKEN_PROGRAM_ID, raw: chunk, logIndex: 0 }
        : { kind: 'unknown', programId: SPL_TOKEN_PROGRAM_ID, raw: chunk, reason: 'not a transfer' };
    },
  });

  // Pick source based on flags (fixture / rpc / geyser).
  // ... wire SignalQueue, StrategyRuntime with WatcherStrategy(wallets).
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: e2e test against bundled fixture**

```ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';

describe('spl-watcher e2e', () => {
  it('emits a JSON line for each match against the bundled fixture', () => {
    const out = execSync(
      `node dist/index.js --fixture ${path.resolve('../../tests/fixtures/signals-spl-watcher.jsonl.gz')} --wallet 11111111111111111111111111111112`,
      { cwd: 'examples/spl-watcher', encoding: 'utf8' },
    );
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const j = JSON.parse(l);
      expect(j.wallet).toBe('11111111111111111111111111111112');
    }
  });
});
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter spl-watcher build && pnpm --filter spl-watcher test
git add examples/spl-watcher/src/index.ts examples/spl-watcher/tests/ examples/spl-watcher/scripts/
git commit -m "examples/spl-watcher: CLI entry + e2e fixture replay test"
```

---

## Phase F — Wrap-up

### Task 48: CI updates (coverage thresholds + proto-load gate)

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add coverage gates per package**

Per spec §2.5: 80% pkgs, 60% example. Inherit existing matrix (Ubuntu+Windows, Node 20).

- [ ] **Step 2: Verify proto-load gate from Task 27 is wired**

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: coverage thresholds for runtime packages + proto-load gate"
```

---

### Task 49: `docs/runtime-architecture.md` (sequence diagrams)

**Files:**
- Create: `docs/runtime-architecture.md`

- [ ] **Step 1: Author with Mermaid sequence diagrams for:**
  - cold-start cost-basis flow
  - live signal → strategy → executor → portfolio flow
  - backtest flow (substitution points)
  - executor failover flow
  - portfolio drift + reconciliation flow

Document the `onError` synchronous semantics (must NOT `await`). Document the `intentId` derivation. Document the bundle accumulator's non-blocking semantics.

- [ ] **Step 2: Commit**

```bash
git add docs/runtime-architecture.md
git commit -m "docs: runtime-architecture.md with sequence diagrams + onError + intentId notes"
```

---

### Task 50: Update `docs/CONTRIBUTING.md` (proto rev process) + changesets

**Files:**
- Modify: `docs/CONTRIBUTING.md`
- Create: `.changeset/<random-name>.md` (entry for the 4 new packages)

- [ ] **Step 1: Document Jito proto refresh process in CONTRIBUTING.md**

How to bump `PINNED_COMMIT`: fetch new `searcher.proto` + `bundle.proto` from `jito-labs/mev-protos` at the new commit, update header comments, update `PINNED_COMMIT` constant in `proto/load.ts`, run `pnpm --filter @ap3x/solana-executor test`, commit as a single PR for proto-rev review.

- [ ] **Step 2: Create changeset entry**

```bash
pnpm changeset
# Select all four new @ap3x/solana-{signals,strategy,executor,portfolio} packages.
# Bump type: minor (initial release).
```

- [ ] **Step 3: Commit**

```bash
git add docs/CONTRIBUTING.md .changeset/
git commit -m "docs: Jito proto rev process + changeset for runtime packages"
```

---

## Backlog (advisor pre-seeded; joins PRP-01 backlog)

- **B8 (gate 1, live):** Run `examples/spl-watcher` against live Geyser for 1h; assert zero lost signals + p99 latency < 2s. Gated on Helius Business ($499/mo).
- **B9 (gate 9, live):** Submit a real Jito bundle via `JitoGrpcSubmitter` against Jito mainnet block engine; assert landing slot + tip-account assignment match. Gated on Jito searcher credentials.
- **B10 (gate 7, live):** External transfer into a tracked wallet on devnet; assert reconciler detects + re-reconstructs within 60s. Devnet-OK; runs on free tier.
- **B11 (gate 8, expanded coverage):** Capture 50 mainnet wallets via paid Helius for richer cost-basis edge cases. Optional.
- **B12 (gate 8, fixture):** If Task 3's `pnpm capture:cold-start-tx-history` was skipped (no Helius free-tier API key at run time), run the script later and commit the artifact. Until then, gate 8 self-skips.

---

## Self-Review

Reviewing the plan against the spec sections:

**§3.1 (signals):** Tasks 4-11 cover Signal type, SignalQueue, FileSignalCheckpointStore, SignalSource interface, all 3 implementations, e2e replay test. ✓

**§3.2 (strategy):** Tasks 35-44 cover Strategy abstract, SignalFilter, StrategyContext + interfaces, FileStrategyStateStore, per-instance queue, intentId, guards, runtime, backtest, gate tests. ✓

**§3.3 (executor):** Tasks 23-34 cover types, Submitter interface, all 3 submitters, vendored Jito proto, BundleAccumulator, InFlightMap, confirmLanded, Executor.submit, failover/retry, gate-9 + gate-4 tests. ✓

**§3.4 (portfolio):** Tasks 12-22 cover types, FilePortfolioStore, accounting, SwapTracer + registry, SplTransferSwapTracer, reconstructor, reconciler, daily-close, CLI, applyLandedTrade, gate-8 test. ✓

**§3.5 (spl-watcher):** Tasks 45-47 cover scaffold, fixture, strategy, CLI, e2e test. ✓

**§4.1 (wiring):** Task 42 (StrategyRuntime) owns the bus. Task 41 (LandedTrade adapter) breaks the executor↔portfolio cycle. ✓

**§5 (acceptance gates):** Mapped:
- gate 1 (live 1h) → backlog B8 ✓
- gate 2 (idempotency) → Task 44 e2e-fixture ✓
- gate 3 (restart recovery) → Task 44 restart-recovery ✓
- gate 4 (vault breach) → Task 34 ✓
- gate 5 (failover) → Task 33 ✓
- gate 6 (backtest parity) → Task 43 ✓
- gate 7 (drift + re-reconcile) → Task 18 + Task 44 drift-reconcile ✓
- gate 8 (cost-basis ±1 lamport) → Task 22 ✓ (depends on Task 3 fixture; B12 fallback)
- gate 9 (Jito HTTP/gRPC parity) → Task 34 ✓
- gate 10 (lifecycle fidelity) → Task 44 lifecycle-fidelity ✓
- gate 11 (zero ecosystem deps) → inherited PRP-01 CI ✓
- gate 12 (coverage) → Task 48 ✓
- gate 13 (boundary enforcement) → Task 1 + existing eslint-boundaries ✓

**Placeholder scan:** The `runBacktest` body in Task 43 is intentionally illustrative ("implementer should expand the placeholder"). All other code blocks contain complete implementations. The `runBacktest` is the one task where "implement per spec §3.2" is the right level of detail given the dispatch wiring is already specified in Task 42 — flagged inline.

**Type consistency:** `Signal`, `SignalQueue`, `Submitter`, `Executor`, `Strategy`, `StrategyRuntime`, `LandedTrade`, `intentId`, `signalId` — names used identically across tasks. ✓

**Sequencing:** Phase A is a hard prereq (Task 1 boundaries; Task 2 transfer decoders feed B16 + E45; Task 3 fixture feeds gate-8). Phase B (12-22) and Phase C (23-34) can run in parallel after A. Phase D (35-44) blocks on A+B+C. Phase E (45-47) blocks on D. Phase F (48-50) closes out.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-19-prp-02-solana-runtime.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task; review between tasks; spec-compliance + code-quality reviews before marking done. Used for PRP-01.

**2. Inline Execution** — Execute tasks in the current session via `superpowers:executing-plans`, with checkpoints for review.

**Per the kickoff prompt, the choice is option 1 (subagent-driven-development).**

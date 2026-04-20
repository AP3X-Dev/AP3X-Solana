# PRP-02 — Solana runtime design spec

**Source PRP:** `roadmap/02-solana-runtime.md`
**Author:** CJ (advisor-approved during autonomous run `autonomous-prp-02-2026-04-19`)
**Status:** approved (advisor)
**Builds on:** `docs/superpowers/specs/2026-04-19-prp-01-solana-substrate-design.md`

## 1. Goal restatement

Ship the **venue-agnostic Solana runtime** as four new packages on top of the PRP-01 substrate:

- `@ap3x/solana-signals` — normalized event stream (live Geyser, historical RPC, fixture replay)
- `@ap3x/solana-strategy` — class-based strategy runtime with 8 lifecycle hooks, per-instance state, backtest harness
- `@ap3x/solana-executor` — decision → signed v0 tx → submission → result; three submitters (RPC, Jito-HTTP, Jito-gRPC)
- `@ap3x/solana-portfolio` — per-lot position tracking with on-chain cost-basis reconstruction, drift reconciliation, daily close

Plus `examples/spl-watcher/` — zero-vertical-code dogfood demonstrating the full signal → strategy path against SPL Token transfers.

After PRP-02, adding a venue (pump.fun PRP-03, Raydium, Orca, Magic Eden, …) means writing a `ProgramDecoder` + optional venue-specific tx builders + a `SwapTracer` for cost-basis fidelity. It does NOT mean re-implementing signal routing, strategy dispatch, retry/idempotency, position tracking, or PnL accounting. The runtime is also a publishable asset on its own — non-vertical products (whale watcher, portfolio tracker, treasury manager) ship as thin apps on `@ap3x/solana-*` with no vertical code.

## 2. Repo + tooling deltas

### 2.1 Workspace layout (additions only)

```
ap3x-solana/
├─ packages/
│   ├─ solana-signals/                                  # NEW
│   ├─ solana-strategy/                                 # NEW
│   ├─ solana-executor/                                 # NEW
│   └─ solana-portfolio/                                # NEW
├─ examples/
│   └─ spl-watcher/                                     # NEW
├─ tests/
│   └─ fixtures/
│       ├─ signals-spl-watcher.jsonl.gz                 # NEW (replay fixture)
│       ├─ portfolio-cold-start-wallets.json            # NEW (10 wallets selected from spl-accounts.json.gz)
│       └─ cold-start-tx-history.jsonl.gz               # NEW (per-tx getTransaction responses for the 10 wallets' lookback window)
└─ docs/
    └─ runtime-architecture.md                         # NEW (sequence diagrams)
```

Each new package mirrors PRP-01 layout: `src/`, `src/index.ts`, `tests/` (or colocated `*.test.ts`), `package.json`, `tsup.config.ts`, `vitest.config.ts`, `tsconfig.json` extending `../../tsconfig.base.json`, `README.md`.

### 2.2 ESLint boundaries extension

Adds 4 new boundary elements + corresponding allowed-import rules. Additions to `eslint.config.mjs` `'boundaries/elements'`:

```js
{ type: 'signals',   pattern: 'packages/solana-signals/src/**' },
{ type: 'strategy',  pattern: 'packages/solana-strategy/src/**' },
{ type: 'executor',  pattern: 'packages/solana-executor/src/**' },
{ type: 'portfolio', pattern: 'packages/solana-portfolio/src/**' },
```

Additions to `'boundaries/element-types'.rules`:

```
{ from: 'signals',   allow: ['core', 'connectivity', 'events'] },
{ from: 'portfolio', allow: ['core', 'connectivity', 'events', 'spl'] },
{ from: 'executor',  allow: ['core', 'connectivity', 'tx', 'vault'] },
{ from: 'strategy',  allow: ['core', 'signals', 'executor', 'portfolio', 'vault'] },
```

Key invariant: **portfolio does not know about executor** and **executor does not know about portfolio**. The `StrategyRuntime` adapts `ExecutionResult` into a portfolio-owned `LandedTrade` shape (see §3.4) and calls `portfolio.applyLandedTrade`. This keeps both packages testable in isolation and avoids a cycle.

The existing `example` rule expands to `['core', 'connectivity', 'tx', 'spl', 'metaplex', 'events', 'vault', 'signals', 'strategy', 'executor', 'portfolio']`.

A new `no-restricted-imports` block scopes `portfolio`'s use of `@ap3x/solana-spl` to the new `decodeTransferInstruction` + `parseTransferLog` exports only (added in §3.4 below) — keeps the assembler/builder graph out of portfolio.

### 2.3 Workspace dependencies

No new runtime deps. All four new packages reuse:
- `@noble/ed25519`, `@noble/hashes` — already in core / vault
- `libsodium-wrappers-sumo` — vault only
- `@grpc/grpc-js`, `@grpc/proto-loader` — already in connectivity (extended to executor for `JitoGrpcSubmitter`)

DevDeps additions: `vitest`, `msw`, `fast-check`, `@vitest/coverage-v8` already at workspace root.

### 2.4 Versioning

All four packages join the synchronized `@ap3x/solana-*` version line via the existing changesets configuration. PRP-01's fixed-version posture applies.

### 2.5 CI

Existing Ubuntu+Windows Node-20 matrix covers all four. Per-package coverage gate: 80% lines/branches/functions on packages, 60% on `examples/spl-watcher`. Forbidden-dep check (`pnpm why @solana/web3.js` etc.) inherited from PRP-01.

A new CI step compiles the vendored Jito proto via `proto-loader` at PR time — drift between vendored copy and pinned commit hash fails the build.

### 2.6 Vendored Jito proto

`packages/solana-executor/src/proto/searcher.proto` + `bundle.proto` vendored from `jito-labs/mev-protos` at a pinned commit hash (recorded in a top-of-file comment, mirrors `solana-connectivity/src/proto/yellowstone.proto` from PRP-01 T14). Refresh process documented in `docs/CONTRIBUTING.md`. License attribution added.

## 3. Package designs

### 3.1 `@ap3x/solana-signals`

Normalized event stream. Decoded events flow in from a `SignalSource`, are deduped by deterministic `signalId`, queued in a bounded buffer, and delivered to subscribers. Restart-safe via `SignalCheckpointStore`.

**Public surface:**

- **`Signal`** — typed shape:
  ```ts
  type Signal = {
    signalId: string;          // base58 of sha256(signature || programId || kind || logIndex)
    ts: number;                // ms since epoch (block time when available, else ingest time)
    slot: number;
    signature: string;         // base58 tx signature
    programId: PublicKey;
    kind: string;              // vertical-defined, e.g. 'spl.transfer', 'pumpfun.buy'
    venue?: string;            // optional: 'spl', 'pumpfun', 'raydium', etc.
    decoded: unknown;          // typed via vertical's decoder; consumer narrows by `kind`
    raw: ProgramLogChunk;      // original from solana-events
  };
  ```
  `signalId` derivation lives in `core/signalId.ts` (re-exported from solana-signals). Deterministic by construction — same on-chain event yields same ID across all sources (live, historical, fixture).

- **`SignalSource`** — event-emitter contract:
  ```ts
  interface SignalSource {
    readonly name: string;
    start(signal?: AbortSignal): Promise<void>;
    stop(): Promise<void>;
    on(event: 'signal', listener: (s: Signal) => void): this;
    on(event: 'gap',    listener: (g: GapEvent) => void): this;
    on(event: 'error',  listener: (e: Error) => void): this;
  }
  ```

- **Three implementations:**
  - `GeyserSignalSource({ geyserClient, decoderRegistry, programIds, signalIdStrategy?, name? })` — wraps `@ap3x/solana-connectivity`'s `GeyserClient` + `@ap3x/solana-events`'s `EventDecoderRegistry`. Subscribes via Geyser, pipes log payloads through `parseLogs` + the registry, emits one `Signal` per decoded event (and one per `UnknownEventDecode`).
  - `HistoricalSignalSource({ rpcPool, decoderRegistry, programIds, slotRange, batchSize?, name? })` — walks slots lazily via `RpcHistoricalBackfill.fetchEventsForProgram`. Pages on `slotRange` chunks (default 100 slots per call). Emits `Signal`s in slot order; emits `gap` if a chunk returns fewer slots than expected.
  - `FixtureSignalSource({ path, name? })` — replays a `.jsonl.gz` of `Signal` records. Reads the gz file streamingly via Node `zlib` + `readline`. Used in tests + backtest mode.

- **`SignalQueue`** — bounded in-memory queue. Constructor `{ capacity = 10_000, dedupWindow = 5000, dedupTtlMs = 600_000 }`. Subscribers call `subscribe(name, handler)`; producers call `push(signal)`. Behavior:
  - `push` checks dedup window (LRU of last `dedupWindow` `signalId`s with `dedupTtlMs` TTL); duplicate `push` is dropped silently with a `dropped: 'dup'` metric.
  - On overflow (`length >= capacity`), drops oldest with a `dropped: 'overflow'` metric and emits `'overflow'` event with `{count, since}`.
  - Subscribers receive in push-order; per-subscriber back-pressure is the subscriber's problem (signals are pulled, not pushed — handler returns a Promise the queue awaits).

- **`SignalCheckpointStore`** — interface mirrors `FileCheckpointStore` from PRP-01:
  ```ts
  interface SignalCheckpointStore {
    load(subscriber: string): Promise<{ lastSignalId: string; lastSlot: number } | null>;
    save(subscriber: string, ckpt: { lastSignalId: string; lastSlot: number }): Promise<void>;
  }
  ```
  Default backend `FileSignalCheckpointStore({ dir = '.ap3x/signals' })` — atomic tmp+rename per file (`<subscriber>.json`), per-subscriber mutex. On restart, the queue resumes from `lastSignalId` — already-acknowledged signals are skipped via a one-shot dedup pass against the checkpoint.

- **Unknown-variant flow** — `UnknownEventDecode` records from `solana-events` become `Signal { kind: 'unknown', programId, decoded: { reason }, raw }` so consumers route them to a dead-letter sink without losing them.

**Boundaries:** `signals` may import `core`, `connectivity`, `events`. Forbidden imports of `tx`, `spl`, `metaplex`, `vault`.

**Tests:**
- Unit: `signalId` determinism (same inputs → same ID); dedup window LRU eviction; queue overflow + drop-oldest; checkpoint atomic write under simulated kill-mid-write.
- Integration: `FixtureSignalSource` replay → queue → subscriber → assert all signals delivered in order with zero duplicates.
- Integration: `HistoricalSignalSource` against a fake `RpcPool` with synthetic transaction batches; verifies pagination + slot-order ordering.
- Integration: `GeyserSignalSource` against the in-process gRPC loopback used in PRP-01 T14; verifies live decode → queue → checkpoint → restart-resume.

### 3.2 `@ap3x/solana-strategy`

Class-based strategy runtime. The orchestrator (`StrategyRuntime`) owns the bus and wires signals → strategies → executor → portfolio in a single process.

**`Strategy` abstract class:**

```ts
abstract class Strategy {
  abstract readonly name: string;
  abstract readonly filters: SignalFilter[];

  onStart?(ctx: StrategyContext): Promise<void>;
  onShutdown?(ctx: StrategyContext): Promise<void>;

  abstract onSignal(signal: Signal, ctx: StrategyContext): Promise<Decision | null>;
  onExecutionResult?(result: ExecutionResult, ctx: StrategyContext): Promise<void>;
  onPositionChange?(change: PositionChange, ctx: StrategyContext): Promise<void>;
  onBalanceChange?(wallet: string, deltas: BalanceDelta[], ctx: StrategyContext): Promise<void>;
  onTick?(tsMs: number, ctx: StrategyContext): Promise<void>;
  onError?(err: Error, phase: HookPhase, ctx: StrategyContext): void;
}
```

`SignalFilter` is declarative: `{ programId?: PublicKey | PublicKey[]; venue?: string; kind?: string | RegExp }`. Filters are OR-combined within a strategy and AND-combined across the `programId/venue/kind` fields of one filter. The runtime indexes filters by `programId` for O(1) dispatch lookup.

**`StrategyContext`** — read-only access surface, one per strategy instance:

```ts
interface StrategyContext {
  readonly portfolio: PortfolioReadApi;
  readonly vault: VaultReadApi;
  readonly state: StrategyStateStore;
  readonly metrics: MetricsEmitter;
  readonly priceSource?: PriceSource;
  readonly logger: Logger;
  now(): number;
}
```

`PortfolioReadApi` lives in `@ap3x/solana-portfolio` (interface only); `VaultReadApi` lives in `@ap3x/solana-vault` (interface only). Strategy imports types, runtime injects concrete implementations.

`PriceSource` interface defined in this package:
```ts
interface PriceSource {
  getPriceLamportsPerToken(mint: PublicKey, atSlot?: number): Promise<bigint | null>;
}
```
Optional. Runtime constructor takes `priceSource?: PriceSource` and threads same instance into every `StrategyContext`. No registry, no per-strategy override (YAGNI).

**`StrategyStateStore`** — per-instance scoped key-value store, JSON-file-backed by default:

```ts
interface StrategyStateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

`FileStrategyStateStore({ dir = '.ap3x/strategy', strategyName, instanceId })` writes to `<dir>/<strategyName>/<instanceId>/<key>.json` with atomic tmp+rename + per-key mutex (mirror `FileVaultStorage` T11 hardening). The mutex is keyed by file path so concurrent writes to different keys parallelize.

**Strategy instantiation + identity:**
- `runtime.register(strategy: Strategy, instanceId?: string)` — `instanceId` defaults to `strategy.name`. Multiple instances of the same class register with distinct `instanceId`s.
- `instanceId` becomes part of the `intentId` derivation (see Idempotency below) so two instances of the same copy-trader watching different whales never collide.

**Per-instance signal serialization:**
- Each registered instance has a private FIFO `Signal` queue.
- The runtime dispatches to one instance at a time, awaiting the prior `onSignal` before invoking the next signal for that instance.
- Different instances run concurrently (Promise.all across instances).
- Other hook callbacks (`onExecutionResult`, `onPositionChange`, `onBalanceChange`, `onTick`) are also serialized through the same per-instance queue so a strategy never observes hooks interleaving with an in-flight `onSignal`.
- `onError` is a synchronous reporter (`void`) and is NOT queued — it fires immediately on any uncaught hook error.

**`StrategyRuntime`** — orchestrator. Constructor:

```ts
new StrategyRuntime({
  signalQueue: SignalQueue,
  executor: Executor,
  portfolio: PortfolioStore,
  vault: Vault,
  priceSource?: PriceSource,
  clock?: () => number,             // injectable for backtests, default Date.now
  tickIntervalMs?: number,           // default 1_000
  guards?: GuardConfig,              // see below
  stateStoreFactory?: (strategyName, instanceId) => StrategyStateStore,
  logger?: Logger,
});
```

Methods: `register(strategy, instanceId?)`, `deregister(instanceId)`, `start()`, `stop()`, `pause(instanceId)`, `resume(instanceId)`.

Lifecycle:
- `register` → instantiate `StrategyContext` → call `onStart` → start per-instance queue + tick interval.
- `start` → subscribe to `signalQueue` + executor result emitter + portfolio change emitter; begin dispatching.
- `stop` → flush per-instance queues (configurable: drain vs drop), call `onShutdown` per instance, cleanup.

**Idempotency (`intentId`):**
- Every `Decision` carries `intentId = base58(sha256(signalId || strategyName || instanceId || decisionVersion))`.
- `decisionVersion` defaults to `'v1'`; strategies can bump it to deliberately re-issue.
- Executor uses `intentId` as the dedup key in its in-flight map.

**Backtest harness:**

```ts
async function runBacktest({
  strategy: Strategy,
  fixtureSource: FixtureSignalSource,
  portfolioStartState?: { positions: Position[]; lots: Lot[] },
  clock: () => number,                   // required: deterministic
  rng?: () => number,                    // optional: seeded for determinism
  simulatedExecutor?: SimulatedExecutorConfig,
}): Promise<BacktestResult>;
```

`SimulatedExecutorConfig` configures landing success rate, latency distribution, fee tier landed-cost approximation. `BacktestResult` includes `{ trades, realizedPnl, unrealizedPnl, maxDrawdown, sharpe?, decisionLog, lifecycleLog, stateSnapshots, finalPortfolio }`.

Same dispatch path as live — only the signal source and executor are swapped. Lifecycle hooks fire identically. Re-running with the same `clock`, `rng`, and fixture produces byte-identical `decisionLog` + `lifecycleLog` (gate 6).

**Strategy guards** — per-instance limits enforced by the runtime:

```ts
interface GuardConfig {
  maxDecisionsPerMin?: number;      // default 60
  maxOpenPositions?: number;        // default unlimited
  maxLossPerDayLamports?: bigint;   // default unlimited (opt-in)
  errorThreshold?: { errors: number; windowMs: number };  // default 5 errors / 60s
  drawdownThreshold?: bigint;       // default unlimited
}
```

Tripping any guard:
1. Emits structured `strategy.tripped` metric with `{ instanceId, guard, value }`.
2. Calls `onShutdown` to let the strategy flush state cleanly.
3. Marks the instance `quarantined`; runtime drops further dispatches with a `dropped: 'quarantined'` metric until `runtime.resume(instanceId)`.

**Boundaries:** `strategy` may import `core`, `signals`, `executor`, `portfolio`, `vault`. Forbidden imports of `tx`, `spl`, `metaplex`, `connectivity` (orchestration only — direct chain access goes through executor / portfolio / vault).

**Tests:**
- Unit: filter matching (programId/venue/kind matrix); intentId determinism; per-instance queue serialization (assert hooks observe no interleaving via instrumented strategy); guard trip behavior per guard type; FileStrategyStateStore atomic-write durability under simulated kill.
- Integration: full lifecycle test — strategy with all 8 hooks implemented receives each in spec'd order against scripted runtime events (gate 10).
- Integration: backtest determinism — run same fixture+clock+rng twice, assert byte-identical decisionLog+lifecycleLog (gate 6).
- Integration: register two instances of same strategy class with different configs, assert isolated state + intentId non-collision.

### 3.3 `@ap3x/solana-executor`

Decision → signed v0 tx → submission → tracked result. Wraps `@ap3x/solana-tx` + `@ap3x/solana-vault` + `@ap3x/solana-connectivity`.

**`TradeIntent`** — venue-agnostic payload:

```ts
type TradeIntent = {
  intentId: string;
  wallet: string;                          // vault wallet name (resolved to WalletHandle)
  instructions: Instruction[];             // composed by venue SDK or strategy
  altHints?: PublicKey[];                  // ALTs to consider for compression
  feeTier: 'low' | 'med' | 'high' | 'turbo';
  computeBudgetHint?: number;              // optional override; else simulate-and-budget
  deadline: number;                         // ms since epoch; executor stops polling after
  submitter?: { kind: 'rpc' | 'jito-http' | 'jito-grpc'; bundleGroup?: string };
  retry?: { maxAttempts?: number; bumpProgression?: boolean };
};
```

**`Executor.submit(intent: TradeIntent): Promise<ExecutionResult>`** — flow:

1. **Idempotency check** — look up `intentId` in `inFlight` map; if present, return its existing promise (no double-submit).
2. **Vault unlock** — `vault.getHandle(intent.wallet)` (handle expected to be unlocked by caller; executor surfaces `WalletLocked` if not).
3. **Compute budget** — if `computeBudgetHint` not provided, call `simulateAndBudget(rpcPool, instructions, payer)` from `@ap3x/solana-tx`; on simulation failure, fall back to `computeBudget = 200_000` with a warning metric.
4. **Priority fee** — `priorityFeeEstimator.tier(intent.feeTier)` returns `microLamportsPerCu`.
5. **Recent blockhash** — fetched from `rpcPool` (`getLatestBlockhash`).
6. **Assembly** — `TransactionAssembler.assemble({ instructions, payer, recentBlockhash, alts? })`.
7. **Sign** — `WalletHandle.signTransaction(message)` → `WalletReserveBreach` is caught and surfaced as `{ kind: 'rejected', error: { code: 'reserve_breach', ... } }`.
8. **Route** — submitter selection:
   - If `intent.submitter` is set, use that submitter kind.
   - Else: configured default (constructor `defaultSubmitter`).
   - If `intent.submitter.bundleGroup` is set, route through bundle accumulator (see below). Bundles require a Jito submitter; if no `jito-http` or `jito-grpc` submitter is configured, `submit()` rejects synchronously with `ConfigError { code: 'no_jito_submitter_for_bundle' }` before queuing.
9. **Submit** — submitter returns `SubmissionAck` (signature or bundle UUID).
10. **Poll for landing** — `confirmLanded(signature, deadline)` polls `getSignatureStatuses` (RPC) or Jito bundle landing endpoint (gRPC/HTTP) until terminal or deadline.
11. **Return `ExecutionResult`:**
    ```ts
    type ExecutionResult =
      | { kind: 'landed';   intentId; signature; slot; submitterUsed; landedAt }
      | { kind: 'dropped';  intentId; signature?; submitterUsed; lastSeenSlot }
      | { kind: 'timeout';  intentId; signature?; submitterUsed }
      | { kind: 'reverted'; intentId; signature; slot; submitterUsed; logs; error }
      | { kind: 'rejected'; intentId; submitterUsed?; error: { code; message; meta? } };
    ```
12. **In-flight cleanup** — on terminal result, remove from `inFlight` map and emit `executor.result` event for portfolio + strategy subscribers.

**`Submitter`** — interface:

```ts
interface Submitter {
  readonly name: string;
  readonly kind: 'rpc' | 'jito-http' | 'jito-grpc' | 'custom';
  submit(payload: SubmitPayload): Promise<SubmissionAck>;
  health(): SubmitterHealth;
}

type SubmitPayload =
  | { kind: 'tx'; signedTx: Uint8Array }
  | { kind: 'bundle'; signedTxs: Uint8Array[]; tipLamports: bigint };
```

**Three implementations ship:**

- **`RpcSubmitter({ rpcPool })`** — calls `rpcPool.pinForWrite()` → `sendTransaction(signedTx, { skipPreflight: true, maxRetries: 0 })`. Health = pinned endpoint health. Default for single-tx intents.

- **`JitoHttpSubmitter({ httpClient, blockEngineUrl, tipAccount, authToken? })`** — POSTs to `blockEngineUrl + '/api/v1/bundles'`. Uses `@ap3x/solana-tx`'s `JitoBundleBuilder` + `tipInstruction` for composition. Network layer adds: tip-account assignment, auth header, structured ack parse.

- **`JitoGrpcSubmitter({ grpcEndpoint, tipAccount, authToken?, protoCommit })`** — bidirectional gRPC against `searcher.proto`'s `SearcherService.SendBundle`. Uses `@grpc/grpc-js` + `@grpc/proto-loader` against the vendored proto in `src/proto/`. `protoCommit` matches the pinned commit hash (CI gate verifies). Health = stream connectivity + last ack latency.

**Submitter routing policy:**
- Executor constructor accepts `submitters: Submitter[]` (ordered by preference per kind) and `defaultSubmitter: 'rpc' | 'jito-http' | 'jito-grpc'`.
- Per-intent: `submitter.kind` hint selects the kind; first healthy instance of that kind submits.
- If no healthy submitter of the requested kind, fall back to the next kind in the configured `fallbackChain` (default `['jito-grpc', 'jito-http', 'rpc']`).
- A single failover attempt per submit (no infinite retry across submitters).

**Bundle composition mechanics** (50ms accumulator, non-blocking):

- Per `bundleGroup`, executor maintains a `BundleAccumulator { intents: PendingIntent[]; timer: NodeJS.Timeout | null; }`.
- When `submit(intent)` arrives with a `bundleGroup`:
  1. Validate submitter kind is `jito-http` or `jito-grpc`; if not, reject with `ConfigError`.
  2. Push `{ intent, signedTx, resolve, reject }` to the accumulator.
  3. If accumulator length hits 5 (Jito limit), cancel timer, flush immediately.
  4. Else if no timer running, start one (`bundleWindowMs`, default 50ms).
- Timer fires → assemble bundle via `JitoBundleBuilder.compose(signedTxs)` → submit via Jito submitter → on `SubmissionAck`, hold all intents' promises pending landing; per-intent `confirmLanded(signature, deadline)` resolves each promise with its individual `ExecutionResult`.
- `submit()` callers see no blocking; their Promise resolves when the bundle (or their individual tx) lands.

**Idempotency:**
- `inFlight: Map<intentId, Promise<ExecutionResult>>`.
- Duplicate `submit(intent)` within an in-flight window returns the same Promise — no double-execution.
- On terminal result, entry is removed; later submits with same `intentId` re-execute (the strategy must bump `decisionVersion` to deliberately re-issue).

**Retry policy:**
- Configurable per intent via `retry: { maxAttempts = 1, bumpProgression = true }`.
- On `dropped`: retry up to `maxAttempts`. If `bumpProgression`, bump fee tier `low → med → high → turbo` per attempt. Each attempt logs to `executor.attempt` metric.
- On `timeout`: caller decides — strategy's `onExecutionResult` receives the timeout result and may re-issue.
- On `reverted`: NO automatic retry (revert is deterministic — same tx will revert again). Surfaced to strategy.
- On `rejected`: NO retry (config / vault / wallet error).

**Vault integration:**
- Executor refuses to submit if `WalletHandle.signTransaction` throws `WalletReserveBreach` — surfaces as `rejected` with `code: 'reserve_breach'`.
- Same for `WalletLocked`, `PassphrasePolicyViolation`, etc. → `rejected` with the corresponding error code.

**Boundaries:** `executor` may import `core`, `connectivity`, `tx`, `vault`. Forbidden imports of `strategy`, `signals`, `portfolio`, `spl`, `metaplex`. The runtime owns the `ExecutionResult → LandedTrade` adapter (see §4.1) — executor stays self-contained.

**Tests:**
- Unit: idempotency (double-submit returns same promise); fee-tier bump progression on dropped retry; bundle accumulator (timer flush, length flush); router fallback chain.
- Unit: vault reserve breach → `rejected{reserve_breach}` (gate 4).
- Integration: in-process gRPC fake hosting `SearcherService.SendBundle` (mirrors PRP-01 T14 pattern) — assert `JitoGrpcSubmitter` ack shape matches `JitoHttpSubmitter` against an `msw`-mocked HTTP endpoint (gate 9).
- Integration: provider failover — kill primary RPC mid-execution, assert continuation on backup without losing in-flight intent (gate 5).

### 3.4 `@ap3x/solana-portfolio`

Per-lot position + PnL tracking with on-chain cost-basis reconstruction.

**`Position` + `Lot`:**

```ts
type LotSource = 'trade' | 'airdrop' | 'transfer-in' | 'cold-start-reconstructed' | 'cold-start-unresolved';

type Lot = {
  amount: bigint;                          // tokens (raw, unscaled)
  costBasisLamports: bigint;
  acquiredSlot: number;
  acquiredSig: string;                     // base58
  source: LotSource;
  reconstructedAt?: number;                // ms; only set for cold-start lots
  basisUnresolved?: boolean;               // true for cold-start-unresolved
};

type Position = {
  mint: PublicKey;
  walletAddress: PublicKey;
  lots: Lot[];                             // newest last
  lastUpdatedSlot: number;
};
```

Per-lot storage means switching FIFO/LIFO/avg-cost is a read-side concern, not a data migration.

**`PortfolioStore`** — interface:

```ts
type LandedTrade = {
  signature: string;                       // base58
  slot: number;
  wallet: PublicKey;
  mint: PublicKey;
  amountDelta: bigint;                     // positive = inflow, negative = outflow
  solFlowLamports: bigint;                 // net SOL movement (negative = SOL spent)
  feeLamports: bigint;
  source: 'executor' | 'external';         // 'executor' = our submit; 'external' = drift detection
};

interface PortfolioStore {
  observe(wallet: PublicKey, opts?: ObserveOpts): Promise<void>;
  getPosition(wallet: PublicKey, mint: PublicKey): Promise<Position | null>;
  getAllPositions(wallet: PublicKey): Promise<Position[]>;
  getRealizedPnl(wallet: PublicKey, mint: PublicKey): Promise<bigint>;
  getUnrealizedPnl(wallet: PublicKey, mint: PublicKey, currentPriceLamports: bigint): Promise<bigint>;
  applyLandedTrade(trade: LandedTrade): Promise<PositionChange[]>;
  on(event: 'change',          listener: (c: PositionChange) => void): this;
  on(event: 'realized-pnl',    listener: (e: RealizedPnlEvent) => void): this;
  on(event: 'drift',           listener: (e: DriftEvent) => void): this;
  on(event: 'cost-basis-incomplete', listener: (e: CostBasisIncompleteEvent) => void): this;
}

interface PortfolioReadApi {                 // subset injected into StrategyContext
  getPosition: PortfolioStore['getPosition'];
  getAllPositions: PortfolioStore['getAllPositions'];
  getRealizedPnl: PortfolioStore['getRealizedPnl'];
  getUnrealizedPnl: PortfolioStore['getUnrealizedPnl'];
}
```

**`FilePortfolioStore`** — default backend. JSON-per-wallet at `.ap3x/portfolio/<walletBase58>.json`. Atomic tmp+rename + per-wallet mutex. Audit log at `.ap3x/portfolio/<walletBase58>.audit.jsonl` (append-only, every applyExecutionResult / cold-start lot / drift event / manual correction).

**Cost-basis reconstruction (cold start)** — algorithm:

```
fn reconstruct(wallet, mint, lookbackDays = 90):
  1. Walk signatures: rpcHistoricalBackfill.iterateSignaturesForAddress(wallet, { until: now - lookbackDays })
     in reverse-chronological order (newest first).
  2. For each signature:
     a. Fetch transaction meta via rpcPool.call('getTransaction', [sig, {maxSupportedTransactionVersion: 0}]).
     b. Extract pre/post token balances for `mint` filtered to `wallet`'s token account (derived via getAssociatedTokenAddress).
     c. Compute walletDelta = postAmount - preAmount.
     d. If walletDelta == 0: skip (this tx didn't touch our position).
     e. If walletDelta > 0 (inflow):
        i.   Try registered SwapTracers: for each tracer where tx.programIds includes tracer.programId, call tracer.trace(tx, wallet, mint).
        ii.  If any tracer returns { kind: 'swap', solOut, tokensIn }:
             → Lot { amount: tokensIn, costBasisLamports: solOut, source: 'trade', acquiredSlot, acquiredSig }.
        iii. Else if any tracer returns { kind: 'transfer-in', sourceWallet }:
             → If sourceWallet is tracked, look up source's outflow lot at this sig and inherit costBasis;
               else → Lot { amount: walletDelta, costBasisLamports: 0n, source: 'transfer-in', ... }.
        iv.  Else (no tracer matched): apply SOL-outflow heuristic:
             - solOutflow = sum(meta.preBalances[wallet] - meta.postBalances[wallet]) - feeLamports.
             - If solOutflow > 0 AND no other token outflow from wallet in same tx:
               → Lot { amount: walletDelta, costBasisLamports: solOutflow, source: 'trade' }.
             - Else if solOutflow == 0 AND no token outflow:
               → Lot { amount: walletDelta, costBasisLamports: 0n, source: 'airdrop' }.
             - Else (mixed/unclassifiable):
               → Lot { amount: walletDelta, costBasisLamports: 0n, source: 'cold-start-unresolved', basisUnresolved: true }.
     f. If walletDelta < 0 (outflow): record realization against existing lots per accounting method (FIFO default).
  3. Stop walking when accumulated position == current on-chain balance OR lookback limit hit.
  4. If lookback limit hit with un-accounted balance > 0:
     → Final lot { amount: unaccounted, costBasisLamports: 0n, source: 'cold-start-unresolved', basisUnresolved: true }.
     → Emit 'cost-basis-incomplete' event { wallet, mint, unaccountedAmount, oldestSlotWalked }.
```

Cold-start runs ONCE per `(wallet, mint)` on first `observe(wallet)`. Result persists; restarts don't re-walk.

**`SwapTracer`** — plug-in interface (extension-safe via `meta`):

```ts
interface SwapTracer {
  readonly programId: PublicKey;
  trace(tx: ParsedTransaction, wallet: PublicKey, mint: PublicKey):
    | { kind: 'swap'; solOut: bigint; tokensIn: bigint; meta?: Record<string, unknown> }
    | { kind: 'transfer-in'; sourceWallet?: PublicKey; meta?: Record<string, unknown> }
    | null;
}

class SwapTracerRegistry {
  register(tracer: SwapTracer): void;
  tracersFor(programId: PublicKey): SwapTracer[];
}
```

PRP-02 ships exactly one tracer: `SplTransferSwapTracer` for plain SPL Token transfers (no SOL swap, classifies as `transfer-in`). Pump.fun (PRP-03) registers a `PumpfunBondingCurveTracer` against the same registry, no breaking changes. Verticals without tracers degrade to the SOL-outflow heuristic.

**SPL transfer decoder** — added to `@ap3x/solana-spl` as new exports (used by both portfolio's `SplTransferSwapTracer` and the spl-watcher example):
- `decodeTransferInstruction(ix: Instruction): { source: PublicKey; dest: PublicKey; amount: bigint } | null`
- `parseTransferLog(chunk: ProgramLogChunk): { source: PublicKey; dest: PublicKey; amount: bigint } | null`

**Cost-basis accounting method** — `FIFO` default. `LIFO` and `avg-cost` selectable per wallet via `observe(wallet, { method: 'fifo' | 'lifo' | 'avg-cost' })`. Method is a read-side function over `lots[]` — no data migration. Accounting helpers live in `src/accounting.ts` (pure functions).

**PnL events:**
- `'realized-pnl'` on every position reduction: `{ wallet, mint, realized, costBasis, proceeds, basisUnresolved, slot }`. `basisUnresolved` flags lots reduced from `cold-start-unresolved` source.
- `getUnrealizedPnl(wallet, mint, currentPriceLamports)` is on-demand (USD conversion is caller's layer).

**Reconciler** — periodic on-chain comparison:

```ts
class Reconciler({ portfolioStore, rpcPool, walletAddresses, intervalMs = 60_000 })
```

Every `intervalMs`:
1. For each tracked wallet, fetch all token accounts via `getTokenAccountsByOwner`.
2. Compare on-chain `amount` to `sum(lots.amount)` per `(wallet, mint)`.
3. Any drift > 0 → emit `'drift'` event `{ wallet, mint, expected, observed, diff, lastKnownLandedSig }`.
4. If drift detected, run incremental cost-basis reconstruction starting from the wallet's `lastUpdatedSlot` for the drifted mint (not full re-walk).

**Daily close** — optional scheduled job. Constructor `Reconciler({ dailyClose: { hour: 0, minute: 0, tz: 'UTC' } })` writes `<wallet>.daily.jsonl` (append-only) capturing positions + realized PnL at midnight per-day. Useful for audit + tax export.

**CLI correction tool** — `pnpm portfolio correct-basis <walletBase58> <mintBase58> <lotIndex> <costBasisLamports>` — surgical fix for the rare manual case. Logs to audit. Lives in `packages/solana-portfolio/src/cli.ts`, registered as `bin: { 'ap3x-portfolio': './dist/cli.js' }`.

**Boundaries:** `portfolio` may import `core`, `connectivity`, `events`, `spl` (limited to the new transfer-decoder exports + `getAssociatedTokenAddress`). Forbidden imports of `tx`, `metaplex`, `vault`, `signals`, `strategy`, `executor`. The runtime owns the `ExecutionResult → LandedTrade` adapter — portfolio never imports executor.

**Tests:**
- Unit: FIFO/LIFO/avg-cost accounting (table-driven cases); SwapTracer registration + dispatch; cold-start algorithm with synthetic transaction sequences (airdrop, trade, transfer-in, mixed); cost-basis-incomplete event when lookback hit.
- Integration: real fixture replay — cold-start reconstruct 10 wallets from `tests/fixtures/spl-accounts.json.gz` + corresponding signature history fixture; assert each lot's costBasis within ±1 lamport of expected (gate 8).
- Integration: drift detection — apply executions, mutate on-chain balance directly in the fake RpcPool, assert reconciler emits drift within 1 cycle and re-reconstruction yields correct lots (gate 7).
- Unit: CLI correction tool round-trip + audit log entry.

### 3.5 `examples/spl-watcher/`

**Goal:** zero-vertical-code dogfood. ~150 LOC. Watches SPL Token transfers to a configurable list of wallets; prints structured JSON-lines on match. No execution leg — proves signal routing in isolation.

**Layout:**
```
examples/spl-watcher/
├─ src/
│   ├─ index.ts              # CLI entry
│   ├─ watcher-strategy.ts   # WatcherStrategy class (one strategy)
│   └─ wallets.ts            # parse --wallet flags
├─ tests/
│   ├─ e2e.test.ts           # replays bundled fixture, asserts exact JSON output
│   └─ wallets.test.ts
├─ scripts/
│   └─ run-historical.sh     # invokes against historical mode w/ Helius RPC
├─ package.json
├─ README.md
└─ tsup.config.ts
```

**Decoder source:** uses `@ap3x/solana-spl`'s new `parseTransferLog` (added in §3.4 above). Registers it against an `EventDecoderRegistry` for the SPL Token program.

**Strategy:** `WatcherStrategy` class with `name: 'spl-watcher'`, `filters: [{ programId: SPL_TOKEN_PROGRAM_ID, kind: 'spl.transfer' }]`, `onSignal(signal, ctx)` checks if `signal.decoded.dest` is in `config.wallets`; if so, emits a `console.log(JSON.stringify({ wallet, sig, slot, amount }))` and returns `null` (no Decision — no execution leg).

**Run modes:**
1. **Fixture mode** (CI default): `pnpm dev --fixture tests/fixtures/spl-watcher.jsonl.gz`.
2. **Historical mode**: `pnpm dev --rpc <helius-url> --slot-from <n> --slot-to <m> --wallet <addr> --wallet <addr>`.
3. **Live mode** (backlog-gated, requires Geyser): `pnpm dev --geyser <url> --wallet <addr>`.

**Tests:** `tests/e2e.test.ts` runs `runBacktest`-style replay against the bundled fixture, asserts the exact JSON-lines output. CI safe.

**Boundaries:** `example` already permits all substrate + runtime packages.

## 4. Cross-cutting concerns

### 4.1 Wiring + data flow

`StrategyRuntime` owns the bus. All wiring is internal `EventEmitter`s — no external bus dep.

```
SignalSource ──push──▶ SignalQueue ──pull──▶ StrategyRuntime
                                                 │
                                ┌────────────────┼────────────────┐
                                ▼                ▼                ▼
                        per-instance     onTick interval    onError reporter
                        signal queue
                                │
                                ▼
                          strategy.onSignal(signal, ctx)
                                │
                                ▼ returns Decision | null
                          executor.submit(intent)
                                │
                                ▼ returns ExecutionResult
                          runtime.adaptToLandedTrades(result)
                                │
                                ▼ returns LandedTrade[]
                  ┌─────────────┼─────────────┐
                  ▼             ▼             ▼
        portfolio.            strategy.    executor.result event
        applyLandedTrade      onExecution-       (for observers)
        (per trade)           Result
                  │
                  ▼ returns PositionChange[]
            strategy.onPositionChange (per change)
                  │
                  ▼
            portfolio.observe wallet balance →
            strategy.onBalanceChange (per delta)
```

`runtime-architecture.md` ships sequence diagrams for: cold-start flow, live signal flow, backtest flow, executor failover flow, portfolio drift+reconciliation flow.

### 4.2 Metrics

Continues PRP-01's `metrics` event pattern. New metric topics:
- `signals.{push,drop,checkpoint}`
- `strategy.{decision,error,tripped,hook-latency}`
- `executor.{submit,attempt,landed,dropped,timeout,reverted,rejected,failover}`
- `portfolio.{lot-added,lot-reduced,realized-pnl,drift,cost-basis-incomplete,reconcile}`

### 4.3 Concurrency + AbortSignal

All async APIs honor `AbortSignal`. `Runtime.stop()` propagates abort to: `SignalSource.stop`, in-flight executor submits (cancels poll loop on deadline if not yet landed), reconciler interval. Per-instance signal queues drain (configurable: `stop({ drain: true | false })`) before `onShutdown`.

### 4.4 Error handling

- All internal errors carry typed `code` + structured `meta` (mirrors `Ap3xError` from PRP-01).
- Strategy hook errors NEVER cross instance boundaries — caught by runtime, routed to `strategy.onError`, counted against `errorThreshold` guard.
- Decoder errors flow through as `kind: 'unknown'` signals (never silently dropped).
- Submitter errors classify as `dropped` / `timeout` / `reverted` / `rejected` — strategy receives `ExecutionResult`, decides next action.

### 4.5 Logging

No package logs to stdout/stderr. All structured via `metrics` events + per-strategy `Logger` (consumer-supplied). `examples/spl-watcher` is the only place that prints.

## 5. Acceptance gate handling

| Gate | Verification | Backlog? |
|---|---|---|
| 1. End-to-end signal round-trip via fixture replay | Integration test in `solana-strategy/tests/e2e-fixture.test.ts` | — |
| 2. Idempotency on duplicate fixture replay | Same test as 1, asserts `executor.submitCount == uniqueIntentCount` | — |
| 3. Restart recovery (SIGKILL after 50 signals) | Integration test that spawns child process, kills mid-stream, asserts no dup/gap on restart | — |
| 4. Vault reserve breach → `rejected{reserve_breach}` | Unit test in `solana-executor/tests/vault-integration.test.ts` | — |
| 5. Provider failover mid-execution | Integration test against fake `RpcPool` with injected primary failure | — |
| 6. Backtest parity (same decisionLog + lifecycleLog across runs) | Integration test in `solana-strategy/tests/backtest-determinism.test.ts` | — |
| 7. Drift detection + incremental re-reconstruction | Integration test in `solana-portfolio/tests/reconciler.test.ts` | — |
| 8. Cost-basis reconstruction ±1 lamport accuracy on 10 mainnet wallets | Integration test against shipped `tests/fixtures/spl-accounts.json.gz` (closed by PRP-01 commit `80eb783` / `3aa221f`) + new `tests/fixtures/portfolio-cold-start-wallets.json` (wallet selection) + new `tests/fixtures/cold-start-tx-history.jsonl.gz` (Helius-captured `getTransaction` responses for each wallet's 90d lookback window) | Tx-history capture is a Phase-A prerequisite, gated on Helius free tier — see §9 |
| 9. Jito HTTP/gRPC submission parity (in-process gRPC fake + HTTP mock) | Integration test in `solana-executor/tests/jito-parity.test.ts` | — |
| 10. Strategy lifecycle fidelity (all 8 hooks fire as spec'd) | Integration test in `solana-strategy/tests/lifecycle-fidelity.test.ts` | — |
| 11. Zero ecosystem deps | CI `pnpm why @solana/web3.js` etc. (inherited) | — |
| 12. Coverage ≥80% packages, ≥60% example | CI threshold | — |
| 13. Boundary enforcement (extended for 4 new layers + vertical guard) | `pnpm lint` via eslint-boundaries | — |

**Backlog (advisor pre-seeded, gated on Helius Business credentials):**
- **B8 (gate 1, live):** Run `examples/spl-watcher` against live Geyser for 1h, assert zero lost signals, p99 ingest-to-strategy latency < 2s.
- **B9 (gate 9, live):** Submit a real Jito bundle via `JitoGrpcSubmitter` against Jito mainnet block engine; assert landing slot + tip-account assignment match.
- **B10 (gate 7, live):** External transfer into a tracked wallet on devnet; assert reconciler detects + re-reconstructs within 60s.
- **B11 (gate 8, live):** Capture additional cost-basis fixtures from 50 mainnet wallets via paid Helius; expand gate-8 coverage.

These join PRP-01's B1/B3/B4/B5 backlog.

## 6. Out of scope (per PRP)

- Venue-specific decoders (pump.fun → PRP-03; Raydium/Orca/Magic Eden/Jupiter → own PRPs).
- Strategy DSL — class-based TypeScript API only.
- Multi-process / distributed runtime — single-process MVP.
- UI / dashboard.
- Live mainnet acceptance on Geyser/Jito (backlog).
- USD price oracles — lamport-denominated PnL only.
- Cross-chain.

## 7. Risks (carried + design-level mitigations)

| Risk (from PRP) | Spec-level mitigation |
|---|---|
| Strategy DSL pressure | Class-based API is DSL-target-compatible; future DSL compiler emits against the 8-hook surface. |
| Live mainnet streaming requires paid Geyser | Backlog B8/B9/B10/B11; in-process gRPC fake covers the protocol surface. |
| Jito gRPC proto churn | Vendored proto + pinned commit hash + CI proto-load gate. |
| Drift could mask a real bug | Drift events carry full context; incremental re-reconstruction surfaces unexplained gaps. |
| Cost-basis reconstruction is RPC-expensive | 90d default lookback (configurable); runs once per `(wallet, mint)` on observe; results persisted; rate-limiting via existing RpcPool. |
| Swap-tracer coverage gaps | Graceful fallback to SOL-outflow heuristic + `cost-basis-incomplete` event; CLI correction. |
| 8-hook complexity overwhelm | Only `name`/`filters`/`onSignal` required; advanced hooks opt-in; example uses minimum surface. |
| StrategyStateStore corruption | Atomic tmp+rename + per-key mutex; tested with kill-mid-write injection. |

## 8. Design decisions log (autonomous-advisor decisions)

| Decision | Choice | Rationale |
|---|---|---|
| Package count | 4 (no separate `solana-runtime` orchestration package) | `StrategyRuntime` belongs with the orchestration logic in `@ap3x/solana-strategy`; an extra package would split a single coherent concern. |
| `ExecutionResult → LandedTrade` adapter location | `StrategyRuntime` (in `@ap3x/solana-strategy`) | Keeps executor and portfolio mutually independent; either can be tested without the other. Strategy already depends on both. |
| `PortfolioReadApi` / `VaultReadApi` location | Defined in their owning packages; strategy imports interface only | No shared-types package needed; keeps boundaries clean. |
| `PriceSource` injection | Single instance via Runtime constructor; no registry, no per-strategy override | YAGNI; per-strategy override can land later if a real use case emerges. |
| Bundle composition | 50ms accumulator + 5-intent flush; non-blocking `submit()` | Matches Jito limit; non-blocking keeps strategies decoupled from bundling. |
| `SwapTracer` extension safety | `meta?: Record<string, unknown>` on every TraceResult variant | Verticals can ship richer payloads without forcing breaking changes to the runtime. |
| SPL transfer decoder location | `@ap3x/solana-spl` (new exports); used by portfolio + spl-watcher | Reusable substrate primitive vs. example-only utility. |
| `intentId` derivation | `sha256(signalId \|\| strategyName \|\| instanceId \|\| decisionVersion)` base58 | Deterministic; multi-instance safe; `decisionVersion` lets strategies deliberately re-issue. |
| Per-instance hook serialization | Single FIFO queue per instance covers ALL hooks (signal/exec/position/balance/tick) | Eliminates in-strategy race conditions; backtest determinism trivially follows. |
| Quarantine on guard trip | `onShutdown` + drop-with-metric until `runtime.resume(instanceId)` | Clean state flush; manual re-enable forces operator review. |
| Backtest determinism | Inject `clock` + `rng`; same dispatch path as live | Gate 6 falls out by construction. |
| Reconciler cadence | 60s default, configurable | Conservative; PRP-03 may tune per-vertical. |
| Cost-basis lookback | 90d default (PRP-stated), configurable per `observe` | Bounds RPC cost; user can extend per wallet when needed. |
| Daily close | Optional, `tz: 'UTC'` default | Audit/tax export is opt-in. |
| Vendored Jito proto | `jito-labs/mev-protos` HEAD as of vendoring; commit hash recorded | Mirrors PRP-01 T14 Yellowstone vendoring; CI proto-load gate catches drift. |
| Boundary on `portfolio → spl` | Limited to new transfer-decoder exports via `no-restricted-imports` | Keeps SPL parser graph from leaking the assembler graph into portfolio. |

## 9. Implementation handoff

This spec hands off to `superpowers:writing-plans` to produce `docs/superpowers/plans/2026-04-19-prp-02-solana-runtime-plan.md`. The plan will:

1. Order package implementation respecting layering:
   - **Phase A (independent):** `solana-signals` (no inter-runtime deps); SPL transfer decoders added to `solana-spl`; cold-start fixture capture (see Phase-A prereq below).
   - **Phase B (requires A):** `solana-portfolio` (depends on transfer-decoder exports + connectivity).
   - **Phase C (requires substrate + signals):** `solana-executor` (depends on tx, vault, connectivity; Jito proto vendoring is a parallel sub-task).
   - **Phase D (requires A+B+C):** `solana-strategy` (orchestrator; depends on signals, executor, portfolio, vault).
   - **Phase E (requires D):** `examples/spl-watcher`.

2. **Phase-A prereq — gate-8 fixture capture.** Plan must include a task to:
   - Select 10 wallets from `tests/fixtures/spl-accounts.json.gz` with non-trivial trade history (heuristic: token accounts with non-zero balances and ≥3 historical signatures within last 90d).
   - Run a new capture script `pnpm capture:cold-start-tx-history` (companion to existing `capture:spl` / `capture:metaplex`) that, for each selected wallet, calls `getSignaturesForAddress` + paginates `getTransaction` for the 90d lookback window, gz-compresses to `tests/fixtures/cold-start-tx-history.jsonl.gz`, and commits.
   - Helius free tier supports both calls; this is NOT credential-gated for live mainnet, only API-key-gated. The capture is a one-time setup task, not an ongoing CI dependency.
   - The committed fixtures power gate-8 in CI; live re-capture is a B11-style backlog item only if expanded coverage is needed later.

3. **TDD discipline per package** — test-first, watch fail, implement, pass, commit per task. Coverage ≥80% on packages, ≥60% on the example.

4. **Tag deferred gates B8/B9/B10/B11 as backlog items**, gated on Helius Business credentials (live Geyser) and Jito mainnet block-engine access (live bundles), joining PRP-01's B1/B3/B4/B5.

5. **Identify parallelizable tasks within phases** for subagent dispatch — e.g., signals' three SignalSource implementations can land in parallel once the `Signal` type and `SignalQueue` exist; executor's three `Submitter` implementations can land in parallel once the `Submitter` interface exists; portfolio's accounting helpers can land in parallel with the cold-start algorithm.

6. **`runtime-architecture.md`** is itself a deliverable (per §6 of the PRP) — plan it as the final Phase-D documentation task, capturing the sequence diagrams for: cold-start flow, live signal flow, backtest flow, executor failover flow, drift+reconciliation flow. Also document the `onError` synchronous semantics so strategy authors don't `await` work inside it.

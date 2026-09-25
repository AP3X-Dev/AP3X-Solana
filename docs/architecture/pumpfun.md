# PRP-02.5 Pump.fun Vertical Architecture

This document describes how the two pump.fun vertical packages —
`@ap3x/pumpfun-events` and `@ap3x/pumpfun-protocol` — sit on top of the PRP-01
Solana substrate and the PRP-02 runtime. It is aimed at PRP-03 implementers
(write-path safety) and strategy authors who will consume these packages to
read, decode, and build pump.fun instructions.

It assumes the reader is already familiar with the substrate and runtime
architecture documented in `docs/runtime-architecture.md`; this doc focuses on
the pump.fun-specific concerns: decoder registration, the bonding-curve /
PumpSwap graduation boundary, the typed read-only client, and the pure
instruction builder surface.

---

## Overview

Pump.fun is the first vertical on the platform. Two packages ship in PRP-02.5:

| Package | Role |
|---|---|
| `@ap3x/pumpfun-events` | Program IDs, log + CPI decoders for both pump.fun programs, typed event union |
| `@ap3x/pumpfun-protocol` | Typed read-only client, bonding-curve + AMM math, pure instruction builders, graduation-aware routing |

**Boundary rule.** `pumpfun-events` depends only on the substrate
(`@ap3x/solana-core`, `@ap3x/solana-events`, `@ap3x/solana-tx`). `pumpfun-protocol`
depends on the substrate plus `pumpfun-events` (it reuses the decoders inside
`fetchRecentTrades`). **Neither pump.fun package depends on any runtime
package.** The runtime depends on substrate only; the runtime is the caller
that wires pump.fun decoders into its `EventDecoderRegistry` and dispatches
pump.fun signals to strategies. This keeps pump.fun a true leaf vertical that
can be versioned and released independently.

**Zero ecosystem deps invariant holds.** No runtime dependency on
`@solana/web3.js`, `@solana/kit`, `@solana/spl-token`, or any
`@metaplex-foundation/*` package. The CI gate `Verify no forbidden deps`
applies across the monorepo and covers pump.fun packages too.

**Stateless.** `@ap3x/pumpfun-protocol` holds no lifecycle state, no
background tasks, no in-memory stream buffers. Live streaming is the runtime's
`SignalQueue` responsibility; callers wanting live pump.fun trades subscribe
to the queue filtering for `pumpfun.trade` / `pumpswap.buy` / `pumpswap.sell` kinds. Historical
backfill of older windows lives in PRP-04's event store.

---

## Package Layering

```mermaid
graph TB
    subgraph "PRP-02.5 — Pump.fun vertical"
        pp["@ap3x/pumpfun-protocol<br/>curve state, AMM math, instruction builders"]
        pe["@ap3x/pumpfun-events<br/>program IDs, decoders, typed event union"]
    end

    subgraph "PRP-02 — Runtime (caller — not a dep)"
        rt["@ap3x/solana-signals<br/>@ap3x/solana-strategy<br/>@ap3x/solana-executor<br/>@ap3x/solana-portfolio"]
    end

    subgraph "PRP-01 — Substrate"
        core["@ap3x/solana-core"]
        conn["@ap3x/solana-connectivity"]
        tx["@ap3x/solana-tx"]
        spl["@ap3x/solana-spl"]
        meta["@ap3x/solana-metaplex"]
        ev["@ap3x/solana-events"]
    end

    pp --> pe
    pp --> core
    pp --> conn
    pp --> tx
    pp --> spl
    pp --> meta
    pp --> ev
    pe --> core
    pe --> tx
    pe --> ev

    rt -. "imports pump.fun decoders + builders<br/>(runtime depends on pump.fun — not the reverse)" .-> pp
    rt -. "registers decoders in EventDecoderRegistry" .-> pe
    rt --> core
    rt --> conn
    rt --> tx

    classDef pumpfun fill:#2d3f5f,stroke:#9cb4d8,color:#e8f0fb
    classDef runtime fill:#3a2d5f,stroke:#b49cd8,color:#f0e8fb
    classDef substrate fill:#2d5f3f,stroke:#9cd8b4,color:#e8fbf0
    class pp,pe pumpfun
    class rt runtime
    class core,conn,tx,spl,meta,ev substrate
```

**Key layering invariants:**

- `pumpfun-events` and `pumpfun-protocol` import **only** from substrate
  packages and from each other. No imports from `@ap3x/solana-signals`,
  `@ap3x/solana-strategy`, `@ap3x/solana-executor`, or
  `@ap3x/solana-portfolio`. This is enforced by
  `eslint-plugin-boundaries` (see `eslint.config.mjs`).
- The runtime imports pump.fun (not the reverse). In app boot code a caller
  does `registry.register(PUMPFUN_BONDING_CURVE_PROGRAM_ID, bondingCurveDecoder)`
  and `registry.register(PUMPFUN_PUMPSWAP_PROGRAM_ID, pumpSwapDecoder)` before
  starting the `GeyserSignalSource`. Other Solana verticals can register their
  own decoders against distinct programs and coexist in the same registry.
- Pure instruction builders return `Instruction` records (from
  `@ap3x/solana-tx`). They do not sign, submit, simulate, or wrap a wallet.
  The PRP-03 write-path safety layer is what will consume these builders and
  add simulate / receipt / policy gating; until PRP-03 lands a strategy that
  wants to submit must do it directly via the runtime's `Executor`.

---

## Sequence: live pump.fun event flow

The hot path. A pump.fun transaction lands on mainnet, Geyser pushes logs to
the runtime, the registered decoder produces a typed event, the
`SignalQueue` dispatches it to every subscribed strategy instance.

```mermaid
sequenceDiagram
    accTitle: Live pump.fun event flow
    accDescr: Geyser stream to decoded pump.fun signal arriving at a subscribed strategy

    participant Chain as Pump.fun on-chain tx
    participant Geyser as Helius Geyser
    participant GSS as GeyserSignalSource
    participant Parser as parseLogs
    participant Reg as EventDecoderRegistry
    participant Dec as bondingCurveDecoder /<br/>pumpSwapDecoder
    participant Q as SignalQueue
    participant RT as StrategyRuntime
    participant Strat as Strategy.onSignal

    Chain->>Geyser: transaction landed
    Geyser->>GSS: ProcessedTransactionUpdate { logs, signature, slot, blockTime }
    GSS->>Parser: parseLogs(logMessages)
    Parser-->>GSS: ProgramLogChunk[] (grouped by programId)

    loop each chunk
        GSS->>Reg: decoderFor(chunk.programId)
        alt chunk.programId is pump.fun
            Reg-->>GSS: pump.fun decoder
            GSS->>Dec: decode(chunk)
            alt known variant
                Dec-->>GSS: PumpFunBondingCurveEvent | PumpSwapEvent<br/>{ kind: "pumpfun.*", ... }
            else unknown discriminator / layout drift
                Dec-->>GSS: UnknownEventDecode<br/>{ kind: "unknown", programId, reason }
            end
            GSS->>Q: push(Signal { kind, signature, slot, blockTime, payload })
        else non-pump.fun program
            Reg-->>GSS: no decoder (or different vertical's decoder)
        end
    end

    Q-->>RT: subscriber callback(sig)
    RT->>RT: SignalFilter.test(sig) per registered instance
    loop each matching instance
        RT->>Strat: onSignal(sig, ctx)
        Strat-->>RT: Decision | null
        Note over RT: Decision, if any, dispatched through<br/>the PRP-02 executor path — see<br/>docs/runtime-architecture.md
    end
```

**Key points:**

- Decoders are **pure functions** `(ProgramLogChunk) => Event | UnknownEventDecode`.
  They never throw on malformed data; unknown discriminators or layout
  mismatches surface as typed `UnknownEventDecode` records with a structured
  `reason` string. This is the substrate invariant — zero silent drops.
- The bonding-curve decoder and the PumpSwap decoder are **registered
  separately** under different program IDs
  (`PUMPFUN_BONDING_CURVE_PROGRAM_ID` and `PUMPFUN_PUMPSWAP_PROGRAM_ID`
  respectively). A single pump.fun transaction touching both programs
  produces multiple decoded events, one per program chunk.
- Slot, signature, and `blockTime` from the Geyser update are attached to the
  signal envelope before it reaches the queue. Decoders themselves care only
  about the log payload bytes; tx-level metadata comes from the source.
- The `SignalFilter.test` call runs per registered strategy instance before
  `onSignal` fires. A strategy uninterested in a particular `kind` (e.g. only
  cares about `pumpfun.create` for launch-detection) never sees unrelated
  variants, which keeps the per-instance `InstanceQueue` idle for noise.

---

## Sequence: graduation boundary (Complete → Migrate → Swap)

Pump.fun tokens migrate from the bonding curve to PumpSwap when the curve
hits its graduation threshold. For a strategy tracking a live position, this
boundary is where routing has to change program and account layout. The
unified `routing.buy` / `routing.sell` helpers hide the boundary: the same
call works before, during, and after graduation.

```mermaid
sequenceDiagram
    accTitle: Graduation boundary — Complete, Migrate, then PumpSwap Swap
    accDescr: How a strategy tracking a position across the pump.fun graduation boundary uses routing.buy and routing.sell to dispatch to the correct builder

    participant Chain as Pump.fun programs
    participant Dec as Decoders (registered)
    participant Q as SignalQueue
    participant Strat as Strategy.onSignal
    participant R as routing.buy / routing.sell
    participant State as curveState / pumpSwapPoolState
    participant BC as buildBuy / buildSell<br/>(bonding curve)
    participant PS as buildPumpSwapSell<br/>(PumpSwap)
    participant Exec as Executor

    Note over Chain: bonding curve reaches threshold
    Chain-->>Dec: CompleteEvent log payload
    Dec-->>Q: Signal { kind: "pumpfun.complete", mint, ... }
    Q-->>Strat: onSignal(completeSignal)

    Note over Chain: pump.fun admin migration (no caller builder)
    Chain-->>Dec: CompletePumpAmmMigrationEvent log payload
    Dec-->>Q: Signal { kind: "pumpfun.complete_pump_amm_migration", mint, pool, ... }
    Q-->>Strat: onSignal(migrateSignal)
    Note over Strat: Strategy observes graduation has<br/>finalised — positions on this mint<br/>now trade on PumpSwap

    Note over Chain: post-graduation: user wants to exit
    Strat->>R: sell(rpcPool, mint, { tokenAmount, minSolOut, ... })
    R->>State: curveState(mint)
    State-->>R: { complete: true, ... }
    alt complete === true
        R->>State: pumpSwapPoolState(canonical pool) + pumpSwapGlobalConfig()
        State-->>R: { pool accounts, coinCreator, fee recipients }
        R->>PS: buildPumpSwapSell({ pool, baseAmountIn, minQuoteAmountOut=minSolOut, ... })
        PS-->>R: Instruction
    else complete === false
        R->>State: globalState()
        R->>BC: buildSell({ mint, user, feeRecipient, creator, amount, minSolOutput, ... })
        BC-->>R: Instruction
    end
    R-->>Strat: Instruction
    Strat-->>Exec: submit(TradeIntent { instructions: [Instruction], ... })
```

**Key points:**

- `CompleteEvent` and `CompletePumpAmmMigrationEvent` are distinct decoded
  variants on the bonding-curve program. `CompleteEvent` fires when the curve
  sells out; `CompletePumpAmmMigrationEvent` fires when pump.fun's admin path
  migrates the reserves into the canonical PumpSwap pool (the same transaction
  carries PumpSwap's `CreatePoolEvent`). Strategies should key off
  `pumpfun.complete_pump_amm_migration` (not `pumpfun.complete`) as the
  authoritative "token now lives on PumpSwap" signal — there is a window
  between the two where the pool does not exist yet.
- `routing.buy` / `routing.sell` perform one `curveState` RPC round-trip per
  invocation, plus one `pumpSwapPoolState` round-trip on the post-graduation
  branch. Strategies trading the same mint in a tight loop should cache the
  state and call the raw builders (`buildBuy` / `buildBuyExactSolIn` /
  `buildSell`, `buildPumpSwapBuy` / `buildPumpSwapBuyExactQuoteIn` /
  `buildPumpSwapSell`) directly to avoid repeated round-trips.
- Slippage is the caller's: `minTokensOut` / `minSolOut` pass straight
  through. Pump.fun fees are tiered by its fee program, so a client-side
  quote would only be approximate.
- PumpSwap has separate `buy` / `buy_exact_quote_in` / `sell`
  instructions; there is no single bidirectional swap. Every trade on either
  program also carries trailing accounts added in pump.fun's April 2026
  upgrade (`bonding-curve-v2` / `pool-v2` and a buyback fee recipient).
- There is **no `buildMigrate` builder.** Migration is triggered by the
  pump.fun program itself on an admin path. Callers cannot — and should not —
  construct migration instructions. The decoded migration event is
  observation only.

---

## `buildCreate` and the initial-buy composition note

**`buildCreate` does not include an initial buy.** It emits a single
`Instruction` that creates the pump.fun mint and initialises the bonding
curve. It does **not** bundle a subsequent `buildBuy` for the creator's first
purchase.

Consumers who want an atomic create-plus-snipe (the common "launch and buy
the dev supply in the same tx" pattern) compose the two builders at the call
site:

```typescript
const ixs = [
  buildCreate(createParams),
  buildBuy(initialBuyParams),
];
const tx = await assemble({ instructions: ixs, payer, signers, blockhash });
```

This keeps both builders pure single-responsibility functions and keeps the
decision about whether to bundle, and at what slippage, in the caller's
hands. A few consequences:

- The creator's `userTokenAccount` (ATA for the new mint) must exist before
  `buildBuy` runs. If it does not, the caller prepends an
  `createAssociatedTokenAccountIx` from `@ap3x/solana-spl` to the bundle.
- The initial-buy amount and the create's `initialVirtualSolReserves` are
  independent parameters. A caller may choose a curve shape and a buy size
  separately.
- A formal launch-and-snipe orchestrator — with vanity-mint grinding, bundle
  sizing, priority-fee tiering for the launch slot, and safety guards around
  Tier-3 irreversible operations like authority revocation — ships in
  **PRP-03.5** alongside the execution-safety write path. PRP-02.5 stops at
  the pure builders.

---

## Typed read-only client

`@ap3x/pumpfun-protocol` ships a stateless, one-shot-RPC read client:

| Method | Purpose |
|---|---|
| `curveState(rpcPool, mint)` | Reads the bonding-curve account; returns typed reserves + `complete` + creator + `createdAt` |
| `pumpSwapPoolState(rpcPool, pool)` | Reads the PumpSwap pool account; typed reserves + LP mint + authorities + fee bps |
| `metadata(rpcPool, mint)` | Composes Metaplex on-chain metadata decode + `MetadataResolver.resolve(uri)` |
| `holders(rpcPool, mint, limit)` | Wraps `@ap3x/solana-spl` largest-accounts / accounts-by-mint |
| `creator(rpcPool, mint)` | Derived from `curveState` |
| `fetchRecentTrades(rpcPool, mint, window)` | `getSignaturesForAddress` + `getTransaction` + decode; one-shot, no subscription |

Every method is a pure request/response. There is **no lifecycle, no
polling, no cache invalidation.** Strategies wanting live streaming subscribe
to the runtime's `SignalQueue`. Strategies wanting historical windows wait
for PRP-04's event store (or scan signatures themselves via
`fetchRecentTrades` for small one-off queries).

---

## Pure instruction builders

All builders return `{ programId, accounts, data }` records compatible with
`@ap3x/solana-tx`'s `assemble`. None of them sign, simulate, or submit.

| Builder | Inputs | Output program |
|---|---|---|
| `buildCreate(params: CreateParams)` | mint, payer, creator, name, symbol, uri | bonding curve |
| `buildBuy(params: BuyParams)` | trade accounts, amount (tokens out), maxSolCost | bonding curve |
| `buildBuyExactSolIn(params: BuyExactSolInParams)` | trade accounts, spendableSolIn, minTokensOut | bonding curve |
| `buildSell(params: SellParams)` | trade accounts, amount, minSolOutput, cashback? | bonding curve |
| `buildPumpSwapBuy(params: PumpSwapBuyParams)` | pool accounts, user, fee recipients, baseAmountOut, maxQuoteAmountIn | PumpSwap AMM |
| `buildPumpSwapBuyExactQuoteIn(params)` | pool accounts, user, fee recipients, spendableQuoteIn, minBaseAmountOut | PumpSwap AMM |
| `buildPumpSwapSell(params: PumpSwapSellParams)` | pool accounts, user, fee recipients, baseAmountIn, minQuoteAmountOut | PumpSwap AMM |

Bonding-curve "trade accounts" are the mint, user, `feeRecipient` and
`buybackFeeRecipient` (from `globalState`) and the curve's `creator` (from
`curveState`); everything else is derived from the IDL.

**Not in scope for PRP-02.5:** `buildMigrate` (admin-only; see above),
`buildSetParams` (admin-only), authority-revocation builders (Tier-3
irreversible — live in PRP-03.5 alongside their policy gating), vanity mint
grinding, launch-and-snipe orchestration, airdrop distribution.

---

## Known program-upgrade gotchas + the nightly diag gate

Pump.fun is an actively maintained program. Its authors can — and do — ship
upgrades that change discriminators, account layouts, or event field
ordering. Our defenses against layout drift:

### Defense 1 — Tolerant decoders, structured unknowns

Decoders never throw on malformed bytes. Any unknown discriminator or
short-read emits `UnknownEventDecode { kind: "unknown", programId, reason }`
with a `reason` string describing the failure mode
(`"short read on CreateEvent name"`, `"unknown discriminator 0xDEADBEEF..."`,
etc.). These records flow through the `SignalQueue` like any other signal —
strategies can filter on `kind === "unknown"` to alarm on drift without
crashing the pipeline.

### Defense 2 — Nightly diag probe

`.github/workflows/ci.yml` runs `pumpfun-nightly-diag` on a `schedule: cron:
'17 5 * * *'` trigger (05:17 UTC). The job installs the monorepo and runs
`pnpm --filter @ap3x/pumpfun-events run diag`, which:

1. Fetches ~20 recent signatures per pump.fun program from a Helius RPC
   endpoint.
2. Pulls each transaction's log payload.
3. Runs both decoders.
4. Computes the ratio of `UnknownEventDecode` outputs to total decoded
   chunks per program.
5. **Fails the CI run (exit 1) if the ratio exceeds 10% for a program we know
   has observed variants.** Below 10% is treated as normal (pump.fun emits
   noise, some non-payload logs).
6. Self-skips (exit 0, no failure) when `HELIUS_API_KEY` is unset — the job
   doesn't break on secret rotation windows or forks.

When the diag fails, the runbook `docs/runbook/pumpfun-fixture-refresh.md`
walks through: pulling a fresh sample, re-running the capture scripts in
`tests/helpers/capture/`, inspecting layout diffs, updating the decoder, and
regenerating the curve / AMM math regression fixtures. Cadence: on-demand
when the diag alarms or when the team notices observable drift.

### Defense 3 — Roundtrip builder tests

Each instruction builder has a roundtrip test: build the instruction,
assemble a tx via `@ap3x/solana-tx`, simulate it against devnet or a mainnet
fork, decode the simulation result, assert the decoded event matches the
params the builder was called with. When pump.fun upgrades the builder's
expected account order or data encoding, the roundtrip test fails before
production code breaks.

### Defense 4 — Fixture regression suite

`packages/pumpfun-events/tests/fixtures/pumpfun-per-variant.jsonl.gz` (one
real transaction per event variant) and
`packages/pumpfun-protocol/tests/fixtures/pumpfun-instructions.json` (one real
instruction per builder) catch decoder and builder regressions at `pnpm test`.
Capture scripts live at `tests/helpers/capture/capture-pumpfun-*.ts` and work
against the public RPC (set `RPC_URL` or `HELIUS_API_KEY` for a faster one).
The lifecycle fixture (`pumpfun-lifecycle.jsonl.gz`) is not captured yet; its
test skips until it is.

---

## Keeping layouts current

### Layouts come from the published IDL

Event and instruction discriminators, event and account field layouts,
instruction account lists and PDA seeds all come from pump.fun's published
IDLs, vendored at `packages/pumpfun-events/idl/` (see the README there for
the source commit). `pnpm --filter @ap3x/pumpfun-events gen:idl` regenerates
`src/generated/idl-schema.ts` after an update.

Programs append fields to events and accounts over time, so decoders accept
any prefix of the current layout that still carries each record's required
fields. Required accounts added after an IDL ships are passed as trailing
accounts (see the builders).

Real mainnet data guards all of this:

- `packages/pumpfun-events/tests/fixtures/pumpfun-per-variant.jsonl.gz` —
  one real transaction per event variant, decoded in CI
  (`pnpm capture:pumpfun-per-variant` refreshes it).
- `packages/pumpfun-protocol/tests/fixtures/pumpfun-instructions.json` — one
  real instruction per builder; the builders must reproduce each one's
  accounts, order and writable flags (`pnpm capture:pumpfun-instructions`).

When pump.fun ships an upgrade: update the IDLs, regenerate, recapture both
fixtures, and run the tests.

---

## References

- PRP spec: `roadmap/02.5-pumpfun-protocol.md`
- Design: `docs/superpowers/specs/2026-04-20-prp-02.5-pumpfun-protocol-design.md`
- Plan: `docs/superpowers/plans/2026-04-20-prp-02.5-pumpfun-protocol.md`
- Runtime architecture (upstream): `docs/runtime-architecture.md`
- Fixture refresh runbook: `docs/runbook/pumpfun-fixture-refresh.md`
- Key source files:
  - `packages/pumpfun-events/src/program-ids.ts` — program ID constants
  - `packages/pumpfun-events/src/bonding-curve/decoder.ts` — bonding-curve decoder
  - `packages/pumpfun-events/src/pumpswap/decoder.ts` — PumpSwap decoder
  - `packages/pumpfun-protocol/src/routing.ts` — graduation-aware `buy` / `sell`
  - `packages/pumpfun-protocol/src/curve/state.ts` — `curveState` read client
  - `packages/pumpfun-protocol/src/pumpswap/pool-state.ts` — `pumpSwapPoolState`
  - `packages/pumpfun-events/idl/` — vendored pump.fun IDLs (source of truth)
  - `packages/pumpfun-protocol/src/instructions/idl-instruction.ts` — IDL-driven account resolution
  - `packages/pumpfun-protocol/src/instructions/bonding-curve.ts` — `buildCreate` / `buildBuy` / `buildBuyExactSolIn` / `buildSell`
  - `packages/pumpfun-protocol/src/instructions/pumpswap.ts` — `buildPumpSwapBuy` / `buildPumpSwapBuyExactQuoteIn` / `buildPumpSwapSell`
  - `packages/pumpfun-events/scripts/diag.ts` — nightly diag probe
  - `.github/workflows/ci.yml` — `pumpfun-nightly-diag` job

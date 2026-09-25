# @ap3x/solana-executor

Transaction execution engine for the AP3X Solana runtime. Builds, signs, and lands versioned (v0) transactions via multiple submitter backends: standard RPC, Jito HTTP bundles, and Jito gRPC.

## Overview

`@ap3x/solana-executor` takes a `TradeIntent` — a fully-specified set of instructions with a fee tier, ALT hints, and optional submitter preference — and returns an `ExecutionResult` that classifies the terminal outcome: `landed`, `dropped`, `timeout`, `reverted`, or `rejected`.

## Key types

- `TradeIntent` — the unit of work: instructions, wallet, fee tier, compute budget hint, deadline, submitter preference, and retry policy
- `Instruction` — a program ID + accounts + data tuple (hand-rolled, no `@solana/web3.js` dependency)
- `FeeTier` — `low` | `med` | `high` | `turbo` (resolved from rolling Geyser percentiles by `@ap3x/solana-tx`)
- `SubmitterHint` — `rpc` | `jito-http` | `jito-grpc` with optional bundle group and Jito tip
- `ExecutionResult` — discriminated union covering all terminal states

## Submission, failover and bundles

- **Failover.** Submitters are tried in preference order (the intent's kind,
  then `fallbackChain`). If one throws, the same signed transaction goes to the
  next within the same attempt. Each built-in submitter marks itself
  `unhealthy` for a cooldown after a failure, so later attempts skip it.
- **Bundles.** Intents sharing a `bundleGroup` are batched into one Jito
  bundle. Each intent is confirmed by its own transaction signature.
- **Tips.** Set `submitter.tipLamports` on at least one intent in a bundle and
  `jitoTipAccount` on the executor; the executor adds the tip transfer to that
  intent's transaction before signing. A bundle with no tip is rejected
  (`bundle_without_tip`), since the block engine would drop it.
- **gRPC** uses TLS by default (`tls: false` for a local plaintext endpoint)
  and sends `authToken` as `authorization` metadata.

## gRPC dependency note

This package depends on `@grpc/grpc-js` and `@grpc/proto-loader`. These are **controlled exceptions** to the project's zero-ecosystem-deps convention, approved in PRP-02 Task 28 (Jito gRPC submitter). They are required solely for the `jito-grpc` submitter path and carry no Solana-SDK coupling.

## Boundary

`solana-executor` may import from `core`, `connectivity`, `tx`, and `vault`. It must not import from `spl`, `metaplex`, `events`, `portfolio`, or any vertical package (`pumpfun-*`).

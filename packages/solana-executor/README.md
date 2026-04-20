# @ap3x/solana-executor

Transaction execution engine for the AP3X Solana runtime. Builds, signs, and lands versioned (v0) transactions via multiple submitter backends: standard RPC, Jito HTTP bundles, and Jito gRPC.

## Overview

`@ap3x/solana-executor` takes a `TradeIntent` — a fully-specified set of instructions with a fee tier, ALT hints, and optional submitter preference — and returns an `ExecutionResult` that classifies the terminal outcome: `landed`, `dropped`, `timeout`, `reverted`, or `rejected`.

## Key types

- `TradeIntent` — the unit of work: instructions, wallet, fee tier, compute budget hint, deadline, submitter preference, and retry policy
- `Instruction` — a program ID + accounts + data tuple (hand-rolled, no `@solana/web3.js` dependency)
- `FeeTier` — `low` | `med` | `high` | `turbo` (resolved from rolling Geyser percentiles by `@ap3x/solana-tx`)
- `SubmitterHint` — `rpc` | `jito-http` | `jito-grpc` with optional bundle group
- `ExecutionResult` — discriminated union covering all terminal states

## gRPC dependency note

This package depends on `@grpc/grpc-js` and `@grpc/proto-loader`. These are **controlled exceptions** to the project's zero-ecosystem-deps convention, approved in PRP-02 Task 28 (Jito gRPC submitter). They are required solely for the `jito-grpc` submitter path and carry no Solana-SDK coupling.

## Boundary

`solana-executor` may import from `core`, `connectivity`, `tx`, and `vault`. It must not import from `spl`, `metaplex`, `events`, `portfolio`, or any vertical package (`pumpfun-*`).

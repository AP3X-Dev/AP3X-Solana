# @ap3x/solana-connectivity

RPC and Geyser connectivity for the AP3X Solana runtime: a health-aware JSON-RPC pool, a Yellowstone gRPC subscriber with gap detection and checkpoints, historical backfill, and the `ap3x-solana-diag` CLI.

## Overview

`RpcPool` spreads JSON-RPC reads round-robin across endpoints, tracking EWMA latency and health (`healthy` / `degraded` / `unhealthy`) for each one. `GeyserClient` streams Yellowstone updates to a handler with backpressure, detects slot gaps and persists checkpoints. `RpcHistoricalBackfill` wraps the history RPC methods and, through `gapBackfill()`, refills the slots a live stream missed.

## Key exports

- **RPC** — `RpcPool` (`call(method, params, opts?)`, `pinForWrite()`, `endpoints()`, emits `'metrics'` with an `RpcMetricEvent`), plus `RpcEndpoint`, `RpcPoolOptions`, `RpcCallOptions`. `rpc_method` errors are not retried. `LatencyTracker` and `HealthState` are the per-endpoint building blocks.
- **Geyser** — `GeyserClient` and `subscribe(req, handler, opts?)`. `opts.signal` is an optional `AbortSignal` that closes the subscription. The returned `Subscription` emits `'update'`, `'dropped'` (`DroppedEvent`), `'gap'` (`GapEvent`), `'error'` and `'closed'`. When the queue (`queueCapacity`, default 1000) is full, the oldest update is dropped. `GrpcAdapter` lets tests inject a fake transport.
- **Checkpoints** — `CheckpointStore` interface and `FileCheckpointStore({ baseDir })`, which writes each checkpoint atomically.
- **Backfill** — `RpcHistoricalBackfill(pool)`: `getSignaturesForAddress`, `iterateSignaturesForAddress` (pages with `before`), `getTransaction` (sets `maxSupportedTransactionVersion` to `1` unless you pass another value), `getBlocks` (in 1000-slot chunks) and `fetchEventsForProgram(programId, range, decoder)`. A decoder that throws yields an `UnknownEventDecode` and does not stop the stream. These `DecodedEvent` / `UnknownEventDecode` types carry `slot` and `signature`; they are separate from the same-named types in `@ap3x/solana-events`.
- **`gapBackfill({ backfill, programIds, decoder, deliver })`** — returns an `onGap(from, to)` handler for `GeyserClient`. It refetches each program's transactions for slots `from` to `to - 1` and passes every decoded event to `deliver`.

## Usage

```ts
import { FileCheckpointStore, GeyserClient, RpcHistoricalBackfill, RpcPool, gapBackfill } from '@ap3x/solana-connectivity';

const pool = new RpcPool({ endpoints: [{ name: 'custom', url: RPC_URL, kind: 'http' }] });
const backfill = new RpcHistoricalBackfill(pool);

const geyser = new GeyserClient({
  endpoint: { url: GEYSER_URL, token: GEYSER_TOKEN },
  checkpointStore: new FileCheckpointStore({ baseDir: '.checkpoints' }),
  onGap: gapBackfill({ backfill, programIds: [PROGRAM_ID], decoder, deliver: handleEvent }),
});

const abort = new AbortController();
geyser.subscribe(
  { transactions: { prog: { vote: false, failed: false, accountInclude: [PROGRAM_ID] } }, commitment: 'confirmed' },
  async (update) => { /* handle one update at a time */ },
  { signal: abort.signal },
);
```

## Diagnostics CLI

`ap3x-solana-diag` (or `pnpm diag` from the repo root) prints a JSON result on stdout:

- `probe-rpc --url <url> [--name <name>] [--timeout <ms>]`
- `probe-geyser --url <url> [--token <tok>] [--insecure] [--duration <ms>]`
- `compare-providers --a-name <n> --a-url <url> --b-name <n> --b-url <url> [--timeout <ms>]`

With `--check`, the command exits 1 when any probe fails. Usage errors exit 2.

## gRPC dependency note

`@grpc/grpc-js` and `@grpc/proto-loader` are allowed exceptions to the zero-ecosystem-deps rule. Yellowstone requires them, and they bring in no Solana SDK. The proto file is vendored under `src/proto/`.

## Boundary

`solana-connectivity` may import only from `core`.

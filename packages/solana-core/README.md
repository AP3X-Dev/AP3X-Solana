# @ap3x/solana-core

Shared primitives for the AP3X Solana substrate: public keys, encodings, Borsh, cluster endpoints, errors, HTTP transport and metrics.

## Overview

`@ap3x/solana-core` is the bottom layer of the substrate. Every other `@ap3x/solana-*` package builds on it, and it depends on no other workspace package. All encoders and parsers are hand-rolled: there is no runtime dependency on `@solana/web3.js`, `@solana/spl-token` or `@metaplex-foundation/*`.

## Key exports

- **Keys** — `PublicKey`: an immutable 32-byte key. Build with `PublicKey.fromBase58(s)` or `PublicKey.fromBytes(bytes)`; read with `toBase58()`, `toBuffer()` (returns a copy) and `equals(other)`. PDA derivation lives in `@ap3x/solana-tx`, not here.
- **Encodings** — `base58.encode` / `base58.decode`; `compactU16.encode` / `compactU16.decode(bytes, offset)` (returns `CompactU16Decoded`: `{ value, length }`).
- **Borsh** — `Reader` and `Writer` (also under the `borsh` namespace). `Reader` covers `readU8/U16/U32/U64/I64`, `readBool`, `readBytes(n)`, `readString`, `readPubkey`, `readVec`, `readOption`; `Writer` has the matching `write*` methods and `toBytes()`. 64-bit values are `bigint`. Reading past the end of the buffer throws.
- **Clusters** — `Cluster` enum (`Mainnet`, `Devnet`, `Testnet`, `Custom`) and `clusterRpcUrl(cluster, customUrl?)`. `Custom` requires `customUrl`.
- **Errors** — abstract `Ap3xError` (stable `code`, optional `cause`) and its subclasses `RpcError` (`rpc.<RpcErrorCode>`), `DecodingError` (`decode`), `TimeoutError` (`timeout`) and `ConfigError` (`config`), each with a typed `meta`.
- **HTTP** — `HttpClient`: a `fetch` wrapper with per-request timeout, optional retry (`RetryPolicy`) and an optional circuit breaker (`CircuitBreakerPolicy`). Emits `'metrics'` (`HttpMetrics`) per request and `circuit:<state>` on breaker transitions.
- **Metrics** — the process-wide `metrics` emitter and `emitMetric(event)`, which stamps `ts` when omitted. Subscribe with `metrics.on('metric', handler)`.

## Usage

```ts
import { Cluster, PublicKey, Reader, Writer, clusterRpcUrl, metrics } from '@ap3x/solana-core';

const mint = PublicKey.fromBase58('So11111111111111111111111111111111111111112');

const w = new Writer();
w.writeU64(1_000n);
w.writePubkey(mint);

const r = new Reader(w.toBytes());
r.readU64();                  // 1000n
r.readPubkey().equals(mint);  // true

clusterRpcUrl(Cluster.Devnet); // 'https://api.devnet.solana.com'
metrics.on('metric', (ev) => console.log(ev.package, ev.op, ev.latencyMs));
```

## Conventions

- Emit metrics through `emitMetric`, not `metrics.emit` directly, so `ts` is always set.
- Throw an `Ap3xError` subclass rather than a bare `Error` when the failure has a stable category.

## Boundary

`solana-core` may not import from any other workspace package. Every other substrate package may import from it.

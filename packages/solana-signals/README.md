# @ap3x/solana-signals

Normalized on-chain event stream for the AP3X Solana runtime.

## Overview

`@ap3x/solana-signals` defines the canonical `Signal<T>` record type and the deterministic `signalId` derivation function. A `Signal` is the normalized form of a decoded on-chain event — it carries decoded data alongside its provenance (slot, signature, program, log index) and a stable identifier that is identical whether the event is encountered during live streaming, historical replay, or fixture-based testing.

## Signal identity

`signalId` is a base58-encoded SHA-256 hash of:

```
signature \x00 programId \x00 kind \x00 logIndex
```

The `\x00` separator prevents collisions across field boundaries. Two events in the same transaction that decode to the same `kind` but at different `logIndex` positions get distinct IDs.

## Boundary

`signals` may import from `core`, `connectivity`, and `events` only. It must not import from `tx`, `spl`, `metaplex`, or `vault`.

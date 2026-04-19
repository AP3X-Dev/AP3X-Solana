# Geyser test fixtures

## `geyser-stream-sample.bin`

A synthetic, length-prefixed binary sample of `SubscribeUpdate` messages
encoded with the vendored `yellowstone.proto` at `src/proto/`. It contains:

1. A slot update at slot 100 (status=PROCESSED).
2. A slot update at slot 101 (status=PROCESSED).
3. A slot update at slot 105 (status=PROCESSED) — forms a gap at 102..104.
4. A ping update.

File layout: for each message, a 4-byte little-endian length prefix followed
by `length` bytes of the protobuf-encoded `SubscribeUpdate`.

The fixture is intentionally small — `GeyserClient` unit tests in
`src/geyser-client.test.ts` build updates in memory via a fake
`GrpcAdapter`, which is faster and gives precise control over timing.
This fixture exists so later integration work (e.g. a golden-stream
replayer for `examples/solana-watch`) has a reproducible sample without
needing live Geyser credentials.

Regenerate with `scripts/gen-geyser-sample.ts` (not currently checked in —
PRP-01 backlog item).

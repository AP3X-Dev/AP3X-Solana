# @ap3x/solana-events

Transaction log parsing and the program-event decoder framework for the AP3X Solana runtime.

## Overview

`parseLogs` turns a transaction's flat `logMessages` array into a tree of program invocations that keeps CPI depth. `EventDecoderRegistry` walks that tree and applies program-specific decoders that vertical packages register. A chunk with no decoder, or whose decoder throws, becomes a typed `UnknownEventDecode` record and is never dropped silently. The parser is hand-rolled and never throws on malformed lines.

## Key exports

- `parseLogs(logs)` — returns a `TransactionLog`: `{ chunks, parseErrors, logTruncated }`. `logTruncated` is `true` when the runtime printed `Log truncated`. An invocation left open when the log ends gets `success: false` and `failureReason: 'truncated'`.
- `ProgramLogChunk` — one invocation: `programId`, `depth`, `success`, `failureReason?`, `logs` (`Program log:` lines), `dataPayloads` (decoded `Program data:` bytes), `computeUnits?` (`{ consumed, limit }` from the `consumed N of M` line), `returnData?` (from `Program return:`), `children` and `rawLines`.
- `LogParseError` — a line the parser could not classify: `{ lineIndex, line, reason }`.
- `decodeBase64Data(s)` — strict base64 decode. Throws on invalid characters or padding.
- `EventDecoderRegistry` — `register(programId, decoder)` (takes a `PublicKey` or base58 string and returns `this`), `has(programId)`, and `decode(transactionLog)`, which returns a `DecodedEventStream`: `{ events, unknown, parseErrors }` in DFS order.
- `ProgramDecoder<TEvent>` — `{ programId, decode(chunk) }` plus an optional `decodeAll(chunk)`. When `decodeAll` is present, the registry uses it instead of `decode`, so one invocation can emit several events.
- `DecodedEvent`, `UnknownEventDecode`, `EventUnion` — per-chunk outcomes.
- `walkInvocations(transactionLog)` — a pre-order generator that yields `InvocationWalkStep`: `{ chunk, depth, path }`, where `path` is the program IDs from the root.

## Usage

```ts
import { EventDecoderRegistry, parseLogs, walkInvocations } from '@ap3x/solana-events';

const registry = new EventDecoderRegistry().register(PROGRAM_ID, {
  programId: PROGRAM_ID,
  decode: (chunk) => decodeMyEvent(chunk.dataPayloads[0]),
});

const log = parseLogs(tx.meta.logMessages);
const { events, unknown, parseErrors } = registry.decode(log);
if (log.logTruncated) {
  // later invocations and events are missing from this trace
}

for (const { chunk, path } of walkInvocations(log)) {
  console.log(path.join(' > '), chunk.computeUnits?.consumed);
}
```

## Conventions

- Children are not passed to a decoder. The registry recurses, so each CPI frame is matched against its own program's decoder.
- A decoder that recognises its program but not the variant should return an `UnknownEventDecode` instead of throwing.

## Boundary

`solana-events` may import only from `core`.

# @ap3x/pumpfun-signals

Stable, typed signal API for pump.fun. **Interim release** — storage is sqlite-backed today; a later release replaces the storage with a Parquet + DuckDB event store. **Consumers code against the interface, not the storage.**

## Overview

`@ap3x/pumpfun-signals` defines a small, deliberately-narrow surface that products consuming the AP3X-Solana stack will need to make decisions about pump.fun tokens — wallet quality, convergence detection, lifecycle milestones, safety verdicts. The interface is the contract; the sqlite implementation in this package is a reference backend that satisfies it.

The defining property of every method is **`asOf` enforcement**: every query takes an explicit `asOf` timestamp, and the implementation guarantees no data observed *after* `asOf` is included in the response. This matters for honest backtesting — the same query, with the same `asOf`, must return the same answer regardless of when it's run, regardless of what events have arrived since.

## API

```ts
import { PumpfunSignals, type Tier, type ConvergenceState } from '@ap3x/pumpfun-signals';

const signals: PumpfunSignals = /* ... */;

// Wallet quality classification observed at-or-before asOf.
const tier: Tier | null = await signals.walletTier({
  wallet: 'someWalletPublicKey',
  asOf:   new Date('2026-04-29T12:00:00Z'),
});

// "How many distinct buyers, of which tier, bought this mint in the last
// windowMs?" — observed at-or-before asOf.
const convergence = await signals.convergenceState({
  mint:     'pumpFunTokenMint',
  asOf:     new Date('2026-04-29T12:00:00Z'),
  windowMs: 5 * 60_000,
});

// All lifecycle milestones for a mint between since and asOf.
const milestones = await signals.milestoneEvents({
  mint:  'pumpFunTokenMint',
  since: new Date('2026-04-29T11:00:00Z'),
  asOf:  new Date('2026-04-29T12:00:00Z'),
});

// Latest safety verdict observed at-or-before asOf.
const verdict = await signals.safetyVerdict({
  mint: 'pumpFunTokenMint',
  asOf: new Date('2026-04-29T12:00:00Z'),
});

// Per-method version pins for honest backtests.
console.log(signals.versions.convergenceState); // e.g. "v1"
```

## Reference implementation

`SqlitePumpfunSignals` is the reference backend. It stores raw events in a `solana_events` table, derives signals on-demand from that table, and applies `asOf` at the SQL `WHERE` clause so no later-observed event leaks into a query at an earlier `asOf`.

```ts
import { SqlitePumpfunSignals } from '@ap3x/pumpfun-signals';

const signals = new SqlitePumpfunSignals({ path: './pumpfun-signals.db' });
await signals.init();

// Ingest events as they arrive (typically from @ap3x/solana-webhooks +
// @ap3x/solana-signals).
await signals.ingestBuy({
  signature: 'sig...',
  slot:      280_000_000,
  observedAt: new Date(),
  mint:      'pumpFunTokenMint',
  wallet:    'walletPubkey',
  amountSol: 1.5,
});

await signals.close();
```

## Versioning

Each method on `PumpfunSignals` carries an independent `signal_version` string in the `versions` map. Bumping a version is a breaking change to that method's semantics — any consumer pinning the old version must adapt before consuming the new one. Versions are hard-coded per release and never silently drift.

## Storage replacement plan

The sqlite backend in this package is a stopgap. A later release ships a Parquet + DuckDB event store designed for honest backtests at scale (immutable append-only event log, columnar queries, snapshot views per slot). The `PumpfunSignals` interface stays put; only the storage moves. Consumer code does not change.

## Dependency posture

- `better-sqlite3` is an **optional peer dependency** for the reference implementation. Consumers using the sqlite backend install it; consumers wiring their own backend do not.
- Same hand-rolled-where-practical posture as the rest of the AP3X-Solana substrate.

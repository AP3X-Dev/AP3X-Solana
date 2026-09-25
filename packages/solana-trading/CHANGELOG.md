# @ap3x/solana-trading

## 0.4.0

### Minor Changes

- Correctness fixes across the substrate and runtime.
  - **vault** — `signTransaction` signs the message bytes only and returns a
    valid transaction; a role with a SOL reserve must be unlocked with
    `getBalance` and `estimateDelta` (it no longer fails open).
  - **events** — `parseLogs` understands compute-unit, return-data,
    multi-field data and truncation lines (`computeUnits`, `returnData`,
    `logTruncated`); `ProgramDecoder.decodeAll` lets one invocation yield
    several events.
  - **connectivity** — historical backfill fetches the range's own
    transactions (it re-read the newest signatures before); `gapBackfill()`
    turns a Geyser gap into a backfill; `subscribe` accepts an AbortSignal;
    `getTransaction` defaults to v1 transactions.
  - **executor** — bundled intents are confirmed by their real signatures,
    `tipLamports` adds a tip transfer to `jitoTipAccount`, untipped bundles
    are rejected, submitters fail over within an attempt and track their own
    health, Jito gRPC uses TLS and sends its auth token. `SubmitPayload`'s
    bundle variant no longer has `tipLamports`.
  - **portfolio** — real unrealized PnL (`PRICE_SCALE`), realized PnL per
    mint, negative values survive persistence, cost-basis reconstruction
    replays buys and sells from where the position opened (paginated, v1,
    lookup-table aware, transfer basis via hook), `observe`,
    `rebuildPosition`, `correctLotBasis`; `Reconciler`, `writeDailyClose`
    and the accounting helpers are exported and Token-2022 balances count.
  - **strategy** — `maxLossPerDayLamports`, `drawdownThreshold` and
    `maxOpenPositions` are enforced; `onBalanceChange` fires; backtests report
    a PnL series, max drawdown, Sharpe, state snapshots and unrealized PnL.
  - **signals** — live Geyser updates are read from the correct message and
    signals carry the decoded event's kind instead of `decoded`.
  - **trading** — `toExecutorTradeIntent` returns the executor's
    `TradeIntent` type directly.

### Patch Changes

- Updated dependencies
- Updated dependencies [1f8d9a7]
  - @ap3x/solana-executor@0.4.0

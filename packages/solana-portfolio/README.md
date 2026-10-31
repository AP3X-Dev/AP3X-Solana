# @ap3x/solana-portfolio

Position tracking and cost-basis accounting for the AP3X Solana runtime.

## Overview

`@ap3x/solana-portfolio` maintains per-wallet, per-mint `Position` records built from ordered `Lot` entries. It tracks how tokens were acquired (trades, airdrops, transfers, cold-start reconstruction) and provides realized/unrealized PnL computation via the `PortfolioReadApi` interface.

## Key types

- `Lot` — a discrete acquisition event with amount, cost basis (lamports), slot, signature, and source classification
- `Position` — all lots for a (wallet, mint) pair plus the last-updated slot
- `LandedTrade` — a settled on-chain trade that drives position updates
- `PositionChange` — before/after snapshot emitted whenever a position mutates
- `RealizedPnlEvent`, `DriftEvent`, `CostBasisIncompleteEvent` — diagnostic events for downstream consumers

## Tracking a wallet

`FilePortfolioStore.observe(wallet, { method, lookbackDays })` starts tracking:
every token the wallet holds (SPL Token and Token-2022) that has no position
yet is cold-started once from on-chain history by `CostBasisReconstructor`,
which replays buys and sells since the position was opened. `method` selects
`fifo` (default), `lifo` or `avg-cost` for later sells in that wallet.
Transfer-ins take their basis from the optional `transferBasis` hook, or are
marked `basisUnresolved`.

Historical reconstruction stops at an unavailable, incorrectly bound or
incomplete receipt instead of joining older lots across the evidence gap.
Successful execution, exact fees/native balances and indexed token quantities
are required; inventory held before that boundary remains unresolved. Numeric
zero is used only when explicitly recorded, never as a missing fee or quantity.

`Reconciler` compares stored positions with on-chain balances on an interval,
emits drift events, and rebuilds drifted positions via `rebuildPosition`.
Both token programs must return explicit account arrays with valid mint keys
and exact raw u64 amount strings. Unavailable or malformed results reject the
pass before drift or reconstruction; an explicit empty array establishes no
accounts for that program. Background failures call `onError` (stderr by
default); direct `runOnce()` calls reject. Repeated `start()` calls share one
timer, and `stop()` prevents future scheduled passes.

## PnL

- `getRealizedPnl(wallet, mint)` — realized PnL for that mint, in lamports.
- `getUnrealizedPnl(wallet, mint, currentPriceLamports)` — open lots marked to
  `currentPriceLamports`, which is lamports per token base unit × `PRICE_SCALE`
  (1e9, the same convention as the pump.fun price helpers).

FIFO/LIFO recognize the full supplied sale proceeds and consume basis from
the selected lots. Average cost pools the basis, rounds the sold basis down
to lamports, and uses cumulative integer allocation across lots so remaining
token units and basis are conserved. Remaining pooled basis stays provisional
when any input lot has unresolved basis.

## Boundary

`solana-portfolio` may import from `core`, `connectivity`, `events`, and `spl`. It must not import from `tx`, `metaplex`, or `vault`.

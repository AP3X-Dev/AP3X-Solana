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

## Cost-basis methods

`ObserveOpts.method` selects `fifo` (default), `lifo`, or `avg-cost`.

## Boundary

`solana-portfolio` may import from `core`, `connectivity`, `events`, and `spl`. It must not import from `tx`, `metaplex`, or `vault`.

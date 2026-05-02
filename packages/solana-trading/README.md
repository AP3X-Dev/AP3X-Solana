# @ap3x/solana-trading

High-level Solana trading contracts shared by AP3X applications.

This package defines strategy-authored swap intents and executor-facing quote,
simulation, order, and fill result types. It intentionally sits above
`@ap3x/solana-executor`, whose `TradeIntent` is instruction-level and expects a
transaction to already be assembled.

The package has no runtime dependencies. Its instruction-level adapter returns
a structurally-compatible shape so applications can pass the result into their
executor package without forcing the whole transaction stack into every signal
consumer.

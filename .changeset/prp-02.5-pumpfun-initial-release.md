---
"@ap3x/pumpfun-events": minor
"@ap3x/pumpfun-protocol": minor
---

PRP-02.5 — Initial release of the pump.fun vertical packages.

@ap3x/pumpfun-events ships decoders for both pump.fun programs (bonding
curve + PumpSwap AMM) and all observed event variants. Decoders register
with @ap3x/solana-events' EventDecoderRegistry and are driven by
GeyserSignalSource / HistoricalSignalSource / FixtureSignalSource at the
runtime layer. Unknown variants surface as UnknownEventDecode with
structured reasons; never silently dropped.

@ap3x/pumpfun-protocol ships the typed read-only on-chain client
(curveState, pumpSwapPoolState, metadata, holders, creator,
fetchRecentTrades), bonding curve + PumpSwap AMM math validated against
≥200 real captured trades within 1 bps, and pure instruction builders
(buildCreate, buildBuy, buildSell, buildPumpSwapSwap) with typed params.
Unified routing (buy/sell) dispatches across the graduation boundary.
Stateless — no lifecycle, no streaming; live streams use the runtime's
SignalQueue.

Safety layer (simulate, receipt-gated submit, policy, Jito bundle
dispatch, circuit breakers, kill switch) ships separately in PRP-03.

Note: pump.fun packages are NOT part of the fixed-version group with
@ap3x/solana-* — they can version independently as the pump.fun vertical
evolves on its own cadence. Change the .changeset/config.json `fixed`
array if coupled versioning is desired later.

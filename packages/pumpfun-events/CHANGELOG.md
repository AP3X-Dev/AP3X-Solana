# @ap3x/pumpfun-events

## 0.1.0

### Minor Changes

- a12838f: Initial release of the pump.fun vertical packages.

  @ap3x/pumpfun-events decodes every event of the bonding-curve and PumpSwap
  programs. Discriminators and layouts come from pump.fun's published IDLs
  (vendored under `idl/`); older events that carry a prefix of today's fields
  still decode. Typed records cover create, trade, complete, migration,
  creator-fee and set-params on the bonding curve and buy, sell, deposit,
  withdraw and create-pool on PumpSwap; the remaining events decode as
  `pumpfun.other` / `pumpswap.other`. `decodeAll` returns every event an
  invocation emits. Real mainnet transactions back the decoder tests.

  @ap3x/pumpfun-protocol reads BondingCurve, Global, Pool and GlobalConfig
  through the IDL, builds bonding-curve (create, buy, buy_exact_sol_in, sell)
  and PumpSwap (buy, buy_exact_quote_in, sell) instructions from the IDL account
  lists — including the trailing accounts added in pump.fun's April 2026
  upgrade and the reserved fee recipients for mayhem-mode coins — and routes
  buy/sell across the graduation boundary. The builders reproduce captured
  mainnet instructions, and an opt-in test simulates a built buy against the
  deployed program. The curve/AMM math helpers are not yet validated against
  captured trades.

  Stateless — no lifecycle, no streaming; live streams use the runtime's
  SignalQueue.

### Patch Changes

- Updated dependencies
  - @ap3x/solana-events@0.4.0
  - @ap3x/solana-tx@0.4.0
  - @ap3x/solana-core@0.4.0

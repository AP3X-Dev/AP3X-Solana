# pumpfun-watch

Example app showcasing the pump.fun vertical (`@ap3x/pumpfun-events` +
`@ap3x/pumpfun-protocol`) on top of the AP3X Solana substrate.

Subscribes to the pump.fun bonding curve program and the PumpSwap AMM
program, decodes every event variant, and emits a JSON line to stdout for
each decoded event. Uses the `FixtureSignalSource` for offline/CI runs and
is scaffolded for `HistoricalSignalSource` / `GeyserSignalSource` once the
live paths land (backlog B8/B10).

## Packages demonstrated

- `@ap3x/pumpfun-events` — bonding curve + PumpSwap decoders, program IDs
- `@ap3x/pumpfun-protocol` — typed read client (not invoked in the observer)
- `@ap3x/solana-signals` — `FixtureSignalSource`, `SignalQueue`
- `@ap3x/solana-strategy` — `StrategyRuntime`

## Usage

```
node dist/index.js --source fixture [--fixture-path <path>] [--max-events <N>]
node dist/index.js --source historical --rpc <url> --from <slot> --to <slot>
node dist/index.js --source live --geyser <url>
```

Only the `--source fixture` path is fully wired and tested in this PRP.
The historical and live paths throw a TODO pointing at the backlog.

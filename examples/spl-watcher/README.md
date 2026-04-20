# spl-watcher

Example app showcasing the AP3X Solana substrate runtime packages.

Watches a set of wallet addresses and emits a JSON line to stdout whenever any
of them receives an SPL token transfer. Uses the `FixtureSignalSource` for
offline/CI runs and the `GeyserSignalSource` for live operation.

## Packages demonstrated

- `@ap3x/solana-signals` — `FixtureSignalSource`, `SignalQueue`
- `@ap3x/solana-strategy` — `StrategyRuntime`
- `@ap3x/solana-executor` — order execution (dry-run mode)
- `@ap3x/solana-portfolio` — position tracking

## Usage

```
node dist/index.js --wallet <base58> [--wallet <base58>...] [--fixture <path>]
```

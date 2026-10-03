# Carbon oracle

Cross-checks the TypeScript Pump/PumpSwap event decoders (`@ap3x/pumpfun-events`) against
[SevenLabs Carbon](https://github.com/sevenlabs-hq/carbon) (`carbon-pumpfun-decoder`,
`carbon-pump-swap-decoder` 2.0.0) on the mainnet fixtures. Weekly in CI (`carbon-oracle.yml`).

```bash
pnpm --filter "@ap3x/pumpfun-events..." build
cargo build --release --manifest-path tools/carbon-oracle/Cargo.toml   # Rust 1.96.1, pinned in rust-toolchain.toml
node tools/carbon-oracle/compare.mjs packages/pumpfun-events/tests/fixtures/*.jsonl.gz
```

It fails on any field both decoders know but decode differently, and reports fields only one
side knows as schema drift. Coverage on 2026-10-03: Carbon decodes every Pump and PumpSwap event
in the fixtures (create, trade, complete, migration, create pool, buy, sell) with no disagreement;
the vendored IDLs are ahead of Carbon 2.0.0 by 22 trailing fields (holder rewards, buyback fees,
virtual quote reserves and others), which Carbon does not decode yet.

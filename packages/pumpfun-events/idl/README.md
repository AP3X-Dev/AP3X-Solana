# Vendored pump.fun IDLs

Copied from https://github.com/pump-fun/pump-public-docs/tree/main/idl
at commit `e0687ae9b7e064a0f54efc7297c65eecfbba3a8f`.

- `pump.json` — bonding curve program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- `pump_amm.json` — PumpSwap AMM program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

These are the source of truth for event and instruction discriminators, field
layouts and account lists. After updating them, run `pnpm gen:idl` to
regenerate `src/generated/idl-schema.ts`, then run the tests — the
fixture tests decode real mainnet transactions against the new schema.

# Vendored pump.fun IDLs

Copied from https://github.com/pump-fun/pump-public-docs/tree/main/idl
at commit `2293f9a66c654e9fe82dc5e8f4618538f24bb35f`.

- `pump.json` — bonding curve program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- `pump_amm.json` — PumpSwap AMM program `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

These are the source of truth for event and instruction discriminators, field
layouts and account lists. After updating them, run `pnpm gen:idl` to
regenerate `src/generated/idl-schema.ts`, then run the tests — the
fixture tests decode real mainnet transactions against the new schema.

`QuoteControl` has a same-length, non-append upgrade. Its legacy layout is
retained in `legacy-quote-control.json`. `decodeIdlAccount` requires an explicit
`layoutVersion` (`e0687ae9` or `2293f9a6`) to interpret the changed bytes. Without
one it returns unchanged named fields with `layoutVersion: unknown`.

Retained 151-byte curve and 301-byte pool allocations contain legacy padding.
Their default projection stops at the previous published field prefix and marks
the layout unknown. An explicit current version is required to interpret the
extension in these ambiguous allocations. Historical callers can pass the old
version to the account and state decoders without changing original bytes.
Clean shorter prefixes preserve absent appended fields as unknown. Other
mid-field truncations still fail. Tests preserve retained mainnet instruction
fixtures and exercise current layouts separately; no live simulation was run.

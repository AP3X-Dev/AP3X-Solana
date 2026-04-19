# ap3x-solana

This monorepo houses the **Solana substrate** (`@ap3x/solana-*`) and **Solana-venue verticals** (starting with `@ap3x/pumpfun-*`) of the AP3X agent platform. The substrate is a vertical-agnostic Solana agent toolkit; verticals are concrete venue integrations on top of it.

PRPs in `roadmap/` drive all work in this repo. Active: PRP-01 (Solana substrate). Master index: `roadmap/README.md`.

## Conventions

- **Zero ecosystem deps.** No runtime dependency on `@solana/web3.js`, `@solana/kit`, `@solana/spl-token`, or `@metaplex-foundation/*`. Allowed exceptions: `@noble/ed25519` (PDA off-curve check), `libsodium-wrappers` (vault crypto). New exceptions require explicit PRP approval.
- **Versioned (v0) transactions only.** No legacy `Transaction` support anywhere in `@ap3x/solana-tx`.
- **Hand-rolled parsers** for SPL, Metaplex, base58, compact-u16, and Borsh primitives. Regression-tested against real on-chain accounts.
- **Decoder framework owns log/CPI parsing.** Vertical packages register program-specific decoders via `registerDecoder(programId, decoder)`. Unknown variants surface as typed `UnknownEventDecode` records, never silently dropped.
- **Vault never returns raw keypairs.** `WalletHandle` exposes `sign`/`signTransaction`/`address` only. SOL reserve guard enforced at the wallet API layer.
- **Strategies pick fee tiers, never lamports.** Tiers (`low`/`med`/`high`/`turbo`) come from rolling Geyser-observed percentiles, recomputed every slot.
- **Bug fixes target the full class of error**, not just the reported instance. If fixing a hex parser, handle 3/4/6/8-char inputs.
- **Refactors never silently drop supported features.** Confirm before removing or replacing.

## Tooling

- pnpm workspaces + Turbo
- eslint + eslint-plugin-boundaries (enforce package layering)
- Vitest + msw (unit + integration)
- CI matrix: Ubuntu + Windows
- `pnpm diag` health probes per Chad's PRP-1 pattern

## Commits

Per global CLAUDE.md: no AI attribution in commit messages, branch names, or PR descriptions. No `Co-Authored-By` trailers. Natural developer language only.

## AMP Memory

Project: ap3x-solana
Description: Solana substrate (vertical-agnostic agent toolkit) + Solana-venue verticals (pump.fun first) of the AP3X platform
Domain: agent-trading-infrastructure
Project Tag: project:ap3x-solana

Entities:
- ap3x-solana
- @ap3x/solana-core
- @ap3x/solana-connectivity
- @ap3x/solana-tx
- @ap3x/solana-spl
- @ap3x/solana-metaplex
- @ap3x/solana-events
- @ap3x/solana-vault
- @ap3x/pumpfun-protocol
- @ap3x/pumpfun-signals
- @ap3x/core
- examples/solana-watch
- Helius
- Triton
- QuickNode
- Yellowstone gRPC
- Jito

Tags:
- solana
- substrate
- rpc-pool
- geyser
- transactions-v0
- borsh
- spl
- metaplex
- priority-fees
- jito-bundles
- vault
- crypto
- backend
- testing
- api-design
- observability
- monorepo
- pumpfun
- zero-deps

Store Policy:
- default

Priors:
- Zero runtime dependencies on @solana/web3.js, @solana/spl-token, @metaplex-foundation/*; only @noble/ed25519 + libsodium-wrappers permitted
- v0 (Versioned) transactions only; legacy Transaction is explicitly unsupported
- Vault uses libsodium secretbox + Argon2id passphrase derivation; WalletHandle never exposes raw keypair
- Priority fee tiers (low/med/high/turbo) derived from rolling Geyser-observed landed-fee percentiles, recomputed every slot
- Generic event decoder framework lives in solana-events; vertical packages register program-specific decoders, unknown variants emit typed records
- Monorepo uses pnpm workspaces + Turbo + eslint-boundaries + Vitest, CI matrix on Ubuntu + Windows

# ap3x-solana

`@ap3x/solana-*` — a **vertical-agnostic Solana agent toolkit**. Pure Solana primitives with no venue-specific coupling. Any Solana-venue project (pump.fun, Raydium, Orca, Meteora, Magic Eden, Jito, etc.) can `pnpm add @ap3x/solana-*` and build on this substrate without ever touching a specific venue's code.

## Status

Active PRP: **PRP-01 (Solana substrate)** — see `roadmap/01-solana-substrate.md`. Master roadmap index: `roadmap/README.md`.

This monorepo houses the Solana substrate **and** Solana-venue verticals (starting with `@ap3x/pumpfun-*` in PRP-02). The substrate ships independently of any vertical; pump.fun is the first consumer that validates the abstractions.

## Packages

| Package | Purpose |
|---|---|
| `@ap3x/solana-core` | base58, `PublicKey`, `Cluster`, compact-u16, Borsh-lite codec helpers, error types, shared `HttpClient`, metrics emitter |
| `@ap3x/solana-connectivity` | Latency-scored RPC pool with failover, Yellowstone gRPC Geyser client (with backpressure + gap detection + checkpointing), historical RPC backfill helpers, `pnpm diag` health probes |
| `@ap3x/solana-tx` | v0 transaction builder, ALT read support, hand-rolled `findProgramAddress`, priority-fee tier estimator, Jito bundle builder (no dispatcher), simulate-and-budget stub |
| `@ap3x/solana-spl` | SPL Token v1 + Token-2022 mint and account parsers, ATA derivation + instruction builder, holder queries |
| `@ap3x/solana-metaplex` | Metaplex Token Metadata PDA + decoder (v1, v1.3, current), off-chain metadata resolver with LRU + file cache, collection helpers, cNFT stub |
| `@ap3x/solana-events` | Generic event decoder framework: log + CPI parser, instance-based decoder registry, typed `UnknownEventDecode` channel for unknown variants |
| `@ap3x/solana-vault` | Encrypted keypair storage (libsodium secretbox + Argon2id), `WalletHandle` (never returns raw keys), SOL reserve guard, audit log, key rotation |

Plus `examples/solana-watch/` — a ~100 LOC Node script that subscribes to arbitrary program IDs via Geyser and streams typed decoded events to stdout. Substrate-only; zero pump.fun-specific code.

## Conventions

See `CLAUDE.md` for the full set. Highlights:

- **Zero ecosystem deps.** No runtime dep on `@solana/web3.js`, `@solana/kit`, `@solana/spl-token`, or `@metaplex-foundation/*`. Allowed exceptions: `@noble/ed25519` (PDA off-curve check), `libsodium-wrappers` (vault crypto).
- **v0 transactions only.** No legacy `Transaction` support anywhere in `@ap3x/solana-tx`.
- **Hand-rolled parsers** for SPL, Metaplex, base58, compact-u16, Borsh primitives — regression-tested against real on-chain accounts.
- **Decoder framework owns log/CPI parsing.** Vertical packages register program-specific decoders; unknown variants surface as typed `UnknownEventDecode` records, never silently dropped.
- **Vault never returns raw keypairs.** `WalletHandle` exposes `sign`/`signTransaction`/`address` only.
- **Strategies pick fee tiers, never lamports.** Tiers (`low`/`med`/`high`/`turbo`) come from rolling Geyser-observed percentiles, recomputed every slot.

## Tooling

- pnpm workspaces + Turbo
- ESLint flat config + `eslint-plugin-boundaries` (enforces package layering)
- Vitest + msw + fast-check (unit, integration, property-based)
- tsup (esbuild-backed) for builds — dual ESM + CJS + `.d.ts`
- Changesets for fixed/synchronized release of all `@ap3x/solana-*` packages
- CI matrix on Ubuntu + Windows
- Nightly `pnpm diag --check` workflow against live RPC + Geyser endpoints

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm diag --check
```

See `docs/CONTRIBUTING.md` for fixture-capture, vault setup, and the full contribution workflow.

## Commits

Per global conventions: no AI attribution in commit messages, branch names, or PR descriptions. No `Co-Authored-By` trailers. Natural developer language only.

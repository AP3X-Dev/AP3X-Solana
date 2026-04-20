# Contributing to ap3x-solana

This monorepo houses the `@ap3x/solana-*` substrate and Solana-venue verticals. PRPs in `roadmap/` drive all work; the active PRP is **PRP-01 (Solana substrate)** — see `roadmap/01-solana-substrate.md`.

## Ground rules

### Zero ecosystem dependencies

No runtime dependency on:

- `@solana/web3.js`
- `@solana/kit`
- `@solana/spl-token`
- `@metaplex-foundation/*` (any of them)

**Allowed exceptions** (audited, single-purpose crypto):

- `@noble/ed25519` — PDA off-curve check, transaction signing primitive
- `libsodium-wrappers` — vault encryption (Argon2id + xsalsa20-poly1305)

Adding a new exception requires explicit PRP approval. The CI gate runs `pnpm why @solana/web3.js` (and the other forbidden names) and fails the build on any hit.

### v0 transactions only

`@ap3x/solana-tx` builds **versioned (v0) transactions exclusively**. There is no legacy `Transaction` type and there will not be one. ALTs (Address Lookup Tables) are first-class.

### Hand-rolled parsers

SPL mint + token account, Metaplex metadata (v1/v1.3/current), base58, compact-u16, and Borsh primitives are all hand-rolled. They are regression-tested against captured mainnet accounts under `tests/fixtures/`. When fixing a parser bug, target the **full class** of error (e.g., a metadata-version detection bug should be tested against all three versions, not just the one that broke).

### Bug fixes target the full class of error

If you fix a hex parser bug for a 6-char input, also handle 3/4/8-char. If you fix a Token-2022 extension parser for `MintCloseAuthority`, audit `TransferFeeConfig` and `DefaultAccountState` too. Tests should cover the class, not just the instance.

### Refactors never silently drop features

If a refactor removes or replaces an existing capability (e.g., direct API support, an existing decoder), confirm with the PR reviewer (or the operator on solo work) before merging. No silent feature drops.

### Decoder framework owns log/CPI parsing

`@ap3x/solana-events` owns log parsing, CPI normalization, and the registry. Vertical packages register program-specific decoders via `registry.register(programId, decoder)`. Unknown variants surface as `UnknownEventDecode` records on a separate channel — they are never silently dropped.

### Vault never returns raw keypairs

`WalletHandle` exposes only `sign(message)`, `signTransaction(tx)`, and `address: PublicKey`. Raw secret bytes never escape the vault. The SOL reserve guard rejects any spend that would dip into the per-wallet reserve at the wallet API layer.

## Tooling

- **Node:** 20.0.0+ (use `nvm use` if you have an `.nvmrc`)
- **pnpm:** 10.14.0 (specified in root `package.json` `packageManager` field)
- **Test:** Vitest + msw (HTTP mocking) + fast-check (property-based)
- **Lint:** ESLint flat config + `eslint-plugin-boundaries` (enforces package layering — see `eslint.config.js`)
- **Build:** tsup (esbuild-backed, dual ESM + CJS + `.d.ts`)
- **Releases:** Changesets, fixed/synchronized version across all `@ap3x/solana-*` packages

### Common commands

```bash
pnpm install                  # install all workspace deps
pnpm build                    # build all packages
pnpm test                     # run unit tests across the monorepo
pnpm test:integration         # run integration tests (require captured fixtures)
pnpm typecheck                # tsc --noEmit per package
pnpm lint                     # eslint with boundaries
pnpm diag                     # run the diagnostic CLI
pnpm diag --check             # CI-mode probes; exits non-zero on failure
```

### Changeset workflow

1. After making a user-facing change, run `pnpm changeset` and describe the change.
2. Pick `patch` / `minor` / `major` for **one** of the `@ap3x/solana-*` packages — Changesets is configured with a fixed version range over `@ap3x/solana-*`, so all packages bump together.
3. Commit the generated changeset file alongside your code change.
4. On release, run `pnpm version-packages` then `pnpm release`.

## Vendored proto files

### Jito proto files

The `@ap3x/solana-executor` package vendors Jito's `searcher.proto`, `bundle.proto`, `packet.proto`, and `shared.proto` under `packages/solana-executor/src/proto/`. These are pinned to a specific upstream commit (`PINNED_COMMIT` in `packages/solana-executor/src/proto/load.ts`). A CI gate (`Verify Jito proto loads`) runs `loadSearcherProto()` on every build to catch accidental proto breakage.

**Why vendor?** `jito-labs/mev-protos` is not published to npm. Downloading at build time introduces a remote dependency that can fail transiently or be modified without notice. Vendoring + pinning gives us reproducible builds and lets us review every proto change.

**When to rev the pin:**
- Upstream adds a new message field we need (e.g., a new tip-account selection knob).
- Upstream changes an existing field type (breaking change).
- Upstream deprecates a field we use.

**How to rev the pin:**

1. Pick the new commit from `https://github.com/jito-labs/mev-protos/commits/master`. Prefer a tagged release when available.

2. Fetch the four proto files at that commit:
   ```bash
   COMMIT=<new-commit-sha>
   for f in searcher.proto bundle.proto packet.proto shared.proto; do
     curl -sSfL "https://raw.githubusercontent.com/jito-labs/mev-protos/${COMMIT}/${f}" \
       -o "packages/solana-executor/src/proto/${f}"
   done
   ```

3. Update the header comment in each proto file to the standard 4-line format:
   ```
   // Vendored from https://github.com/jito-labs/mev-protos
   // Source: <filename>.proto
   // Commit: <new-commit-sha>
   // Retrieved: YYYY-MM-DD
   ```

4. Update `PINNED_COMMIT` in `packages/solana-executor/src/proto/load.ts` to the new SHA.

5. Run the executor test suite locally:
   ```bash
   pnpm --filter @ap3x/solana-executor test
   ```
   All proto-sensitive tests (`submitters/jito-grpc.test.ts`, `tests/jito-parity.test.ts`) must pass.

6. Commit as a single PR with title `executor: bump Jito proto pin to <short-sha>`. The PR body should link the upstream commit and summarize the upstream changes (what fields added/changed/removed, and why we're taking it in).

7. Proto-rev reviewer checklist (for the reviewer):
   - New commit exists in `jito-labs/mev-protos` master history (no force-pushes).
   - All 4 files updated together (no partial updates).
   - Header comments updated to match new SHA.
   - CI's `Verify Jito proto loads` passes.
   - Submitter tests pass.
   - No new dependencies added to `packages/solana-executor/package.json`.

**When NOT to rev:** if the change is purely cosmetic (whitespace, comments in upstream), skip the rev. Pins should only move when we need the change.

## Fixture capture

When Helius / Triton / QuickNode credentials are available, run capture scripts to refresh on-chain reference fixtures:

```bash
RPC_URL=https://your-rpc-endpoint pnpm capture:spl
RPC_URL=https://your-rpc-endpoint pnpm capture:metaplex
```

These produce gz-compressed JSON fixtures under `tests/fixtures/`. Commit the resulting files. The schema-drift CI check alerts if no fixture refresh has occurred in 30 days.

## `pnpm diag`

The diagnostic CLI lives in `@ap3x/solana-connectivity`. Subcommands:

```bash
pnpm diag probe-rpc <endpoint>
pnpm diag probe-geyser <endpoint>
pnpm diag compare-providers <endpoint-a> <endpoint-b>
pnpm diag --check                         # battery mode for CI; exits non-zero on any failure
```

The nightly CI workflow runs `pnpm diag --check` against env-provided endpoints. Add new probes when a new failure mode is observed in production.

## Commits + PRs

Per the project-wide conventions (see root `CLAUDE.md` and the user's global instructions):

- **No AI attribution** in commit messages, branch names, or PR descriptions.
- **No `Co-Authored-By` trailers** of any kind.
- Use natural developer language. Don't reference 'agent', 'AI', 'Claude', 'automated', or 'LLM' in any user-visible artifact.
- Prefer focused commits (`pnpm changeset` first when applicable, then `git commit` the change + the changeset together).
- PR titles + bodies follow the same convention. Conventional Commits style is fine (`feat:`, `fix:`, `chore:` prefixes), but not required.

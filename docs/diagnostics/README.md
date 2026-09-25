# Diagnostics

Checks that talk to mainnet. None of them need a keypair. They run nightly in
CI (`nightly-diag` in `.github/workflows/ci.yml`, also runnable by hand from the
Actions tab) and can be run locally.

The endpoint is `RPC_URL`, falling back to `https://api.mainnet-beta.solana.com`
(slow and rate-limited, but it works). In CI, set the `SOLANA_RPC_URL` secret to
use a faster endpoint.

| Check | Command | Fails when |
|---|---|---|
| Substrate RPC probe | `pnpm --filter @ap3x/solana-connectivity diag probe-rpc --url <url> --check` | the endpoint does not answer `getSlot` |
| Geyser probe | `pnpm --filter @ap3x/solana-connectivity diag probe-geyser --url <url> [--token <t>] --check` | no slot updates arrive within the window (not in CI — needs a Geyser endpoint) |
| pump.fun decoder coverage | `RPC_URL=<url> pnpm --filter @ap3x/pumpfun-events run diag` | more than 10% of recent event payloads on either pump.fun program decode as unknown |
| pump.fun live simulation | `AP3X_LIVE_RPC=<url> pnpm --filter @ap3x/pumpfun-protocol exec vitest run tests/live-simulation.test.ts` | the deployed program rejects a `buy_exact_sol_in` built from on-chain state |

## What an alarm usually means

- **Decoder coverage** — pump.fun shipped new or changed events. Update the
  vendored IDLs (`packages/pumpfun-events/idl/`), run `pnpm gen:idl`, and
  recapture fixtures (`docs/runbook/pumpfun-fixture-refresh.md`).
- **Live simulation** — the program's accounts or arguments changed (for
  example a new required trailing account). The failing simulation's logs are
  printed; compare against a fresh `pnpm capture:pumpfun-instructions`.
- **RPC probe** — the endpoint is down or rate-limiting; not a code problem.

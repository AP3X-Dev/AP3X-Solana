# pump.fun Fixture Refresh Runbook

Procedure for refreshing the on-chain fixtures that back the
`@ap3x/pumpfun-events` decoder tests and the `@ap3x/pumpfun-protocol` bonding
curve + PumpSwap AMM math regression tests.

Fixture refreshes are **on-demand, not scheduled**. Captured fixtures are
committed to the repo and read by the test suite; they only need to change
when the upstream pump.fun programs change or when we expand coverage.

---

## When to run this

Run a refresh when any of these happen:

1. **The nightly `pumpfun-nightly-diag` CI job fails** with an
   unknown-ratio breach (> 10% `UnknownEventDecode` on either program). That
   alarm means the decoder is seeing log or CPI shapes it does not recognize
   — typically a pump.fun program upgrade changed a discriminator or
   field layout. Refresh the per-variant fixture first, then fix the decoder
   against the new shape.

2. **Program upgrades are announced externally** (pump.fun team
   communications, on-chain BPF loader `Upgrade` events against either
   program ID). Refresh proactively — don't wait for the diag to catch it.

3. **The curve or AMM math regression fixtures have been absent** (the
   ≥100-trade requirement cannot be met from a previous run because the
   Helius capture window was too narrow, or `HELIUS_API_KEY` was not
   available at the time the capture script was last run) and Helius access
   is now available. The `math.test.ts` regression tests self-skip when the
   fixtures are missing, so a refresh turns currently-silent tests into
   actively-enforced gates.

4. **Coverage expansion**: a new variant is observed in production that the
   per-variant fixture does not yet include (diag does not breach but we
   want a regression fixture for the new shape).

Not a reason to refresh: periodic "just in case." The fixtures encode
_shape_, not live state. They only need updating when upstream changes.

---

## Procedure

All commands run from the repo root on a branch (never `main`).

### 1. Export the Helius API key

All capture scripts self-skip cleanly when `HELIUS_API_KEY` is unset. Without
it, the capture scripts exit 0 without writing anything, and regression tests
stay skipped. Export the key for the shell that will run the captures:

```bash
export HELIUS_API_KEY=<key>
```

Helius free tier is sufficient for `getSignaturesForAddress` +
`getTransaction`. No archive-grade plan is required for the per-variant and
lifecycle captures.

### 2. Refresh the per-variant decoder fixture

```bash
pnpm capture:pumpfun-per-variant
```

Writes `tests/fixtures/pumpfun-per-variant.jsonl.gz` — one captured tx per
known variant across both pump.fun programs (bonding curve + PumpSwap AMM).
This fixture backs `packages/pumpfun-events/tests/per-variant.test.ts`.

If the diag breach is what triggered the refresh and the capture still
shows `UnknownEventDecode` for the same variant, fix the decoder in
`packages/pumpfun-events/src/<program>/decoder.ts` against the observed
bytes before proceeding.

### 3. Refresh the full-lifecycle fixture

```bash
pnpm capture:pumpfun-lifecycle
```

Writes `tests/fixtures/pumpfun-lifecycle.jsonl.gz` — a single token's full
lifecycle (Create → trades → Complete → Migrate → post-migration PumpSwap
swaps). Backs `packages/pumpfun-events/tests/lifecycle.test.ts`.

### 4. Refresh the math regression fixtures

The curve math and PumpSwap AMM math regressions at
`packages/pumpfun-protocol/src/curve/math.test.ts` and
`packages/pumpfun-protocol/src/pumpswap/math.test.ts` require **at least
100 real trades each** with pre-trade reserves, observed fills, and fee
basis points. Fixture paths:

- `tests/fixtures/pumpfun-bonding-curve-trades.json` — ≥100 curve trades
  (`TradeRecord` shape: `slot`, `signature`, `preReserves`, `solIn`,
  `tokensOut`, `isBuy`, `feeBasisPoints`)
- `tests/fixtures/pumpfun-pumpswap-swaps.json` — ≥100 PumpSwap AMM swaps
  (`SwapRecord` shape: `slot`, `signature`, `preReserves`,
  `quoteIn`, `tokensOut`, `isBuy`, `feeBasisPoints`)

A dedicated capture script for these is TBD. When writing it, follow the
pattern in `tests/helpers/capture/capture-pumpfun-per-variant.ts`:

- Use `RpcPool` from `@ap3x/solana-connectivity`
- Page `getSignaturesForAddress` against the program ID
- For each signature, call `getTransaction` with
  `maxSupportedTransactionVersion: 0`
- Decode the logs with the appropriate decoder from `@ap3x/pumpfun-events`
- For each `TradeEvent` (curve) or `BuyEvent`/`SellEvent` (PumpSwap),
  fetch the pre-trade reserves from the account snapshot **at the slot
  before** the trade
- Emit one record per trade until ≥100 per side (buy and sell) are
  captured, then write out the JSON array
- Self-skip with exit 0 when `HELIUS_API_KEY` is unset, matching the other
  capture scripts

### 5. Verify the suite

```bash
pnpm -r test
```

Previously-skipping tests should now run. Expect:

- `per-variant.test.ts` — should pass for all variants the decoder knows
- `lifecycle.test.ts` — should pass end-to-end
- `math.test.ts` (both curve and pumpswap) — all trades match within 1 bps

If any regression fails, the decoder or math needs a fix before the fixture
can be committed. Do **not** commit a fixture that causes regressions to
fail — that masks real drift.

### 6. Commit the refreshed fixtures

```bash
git add tests/fixtures/pumpfun-*.jsonl.gz tests/fixtures/pumpfun-*-trades.json tests/fixtures/pumpfun-*-swaps.json
git commit -m "pumpfun fixtures: refresh against pump.fun program <slot>"
```

Replace `<slot>` with the highest slot number from the captured signatures
(grep the capture script stdout, or read it from one of the emitted
records). This makes the commit trivially greppable when correlating a
refresh against a diag alarm or a program upgrade.

---

## Cadence

On-demand only. Do not schedule periodic refreshes — fresh fixtures without
an upstream change are churn and make real drift harder to spot in the git
log.

The nightly `pumpfun-nightly-diag` job is the drift detector; this runbook
is the remediation.

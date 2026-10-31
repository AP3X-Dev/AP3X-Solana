# Pump deployment investigation

Inspected main `75058eef4c00eef43bf028c6d5379bf6f4f47acc`. This commit is dated October 9, not October 17. The October 17 scheduled [CI run 39020603901](https://github.com/AP3X-Dev/AP3X-Solana/actions/runs/39020603901) used it. Main still pointed there at inspection. The only open PR was the unrelated base58 optimization (#2).

## Conclusion

The sampled legacy and v2 SOL/WSOL trade paths remain executable and enforce the tested slippage limits. The public Pump binary interface has not changed since the vendored IDL. This is **partial compatibility evidence, not deployment qualification**. All three deployment baselines are stale. `VERIFIED_DEPLOYS` and the failing upgrade assertion are intentionally unchanged.

| Program | Verified slot | Observed deployment slot |
| --- | ---: | ---: |
| Pump | 452654932 | 456494698 |
| PumpSwap | 452654882 | 454596406 |
| Pump Fees | 452655002 | 456132171 |

Public mainnet `getBlockTime(456494698)` returned `1791906041`, October 13, 2026, 15:40:41 UTC. October 17 was detection by the cited run, not the redeployment date. The original test stops at the first mismatch; new logging exposes all three before asserting.

## Interface review

Compared the vendored `2293f9a66c654e9fe82dc5e8f4618538f24bb35f` source against official [pump-public-docs 639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22](https://github.com/pump-fun/pump-public-docs/commit/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22), dated October 13.

- Pump: recursive JSON comparison excluding documentation and errors is identical. Instruction discriminators, arguments, fixed account order, signer/writable flags, PDA seeds, account fields and event fields are unchanged.
- PumpSwap: the entire vendored JSON is byte-identical to current upstream.
- Pump now documents `create_v2` traversing every coin in a nested quote chain. Remaining accounts must contain each curve and, where migrated, its pool and vaults. New error 6109 is `QuoteChainAccountsRequired`. Static IDL accounts alone cannot describe this requirement. There is no dedicated AP3X create-v2 chain resolver; generic callers must supply the remaining accounts. Do not infer automatic support from the generated schema.
- Upstream Pump Fees adds `withdraw`, `WithdrawEvent`, and errors 6035/6036. AP3X does not vendor that IDL or expose its withdrawal builder. Existing trading passes the fee program/config accounts. No withdrawal was attempted.
- Refreshed Pump JSON exactly from the pinned official commit. Regeneration produces **no generated-schema diff**. Existing layout version `2293f9a6` still identifies the same binary layout. Legacy account padding remains ambiguous and is not promoted to verified fee/depth fields.

See `interface-comparison.json` for source hashes and comparison results.

## Corrections

1. Turbo `typecheck` now depends on its own `build`, as well as dependency builds. Executor integration tests import `@ap3x/solana-executor` through `dist/index.d.ts`. Previously, TypeScript could resolve its JavaScript while tsup was still generating declarations. The Ubuntu job showed exactly this race; it is independent of the upgrade alarm. No ambient `any` declaration, excluded test, or relaxed compiler setting was added.
2. The SOL-denominated convenience buy/sell router rejects custom quote mints before building a trade. Nested coin units must never be implicitly treated as lamports. Explicit v2/generic builders remain available. Three regression cases cover buy/sell before and after graduation and a mismatched pool quote.
3. Live tests are explicitly restricted to read-only RPC methods and `simulateTransaction`. They use zero signatures, signature verification disabled, and never broadcast. Candidate selection restricts SOL/WSOL witnesses. They check exact-output legacy/v2 roundtrips, exact amounts, decoded fee fields, spend-cap rejection (6002), and minimum-output rejection (6003). All deployment results are logged before the unchanged assertion.
4. Added a generic v3 SOL roundtrip witness. Invocation logs identify v3; observed TradeEvent `ixName` is `buy`/`sell`, contrary to the public documentation's v3 names. The decoder preserves those raw fields rather than inventing a version. Its zero fee-recipient marker is tested separately from full fee economics.

## Validation and boundaries

Local environment: Linux, Node 24.19.0, repository-pinned pnpm 10.14.0. CI uses Node 20 and Ubuntu/Windows, so those hosted matrix runs remain necessary.

- Clean `pnpm typecheck`: 38/38 build/typecheck tasks passed, no cache hits.
- `pnpm lint`: 18/18 tasks passed, existing warnings only.
- Affected package tests and coverage gates: events 61 passed; protocol 106 passed; executor 45 passed. Branch coverage: 88.41%, 89.04%, and 85.30% respectively. Existing live/fixture-dependent skips are retained.
- Live test file separately typechecked with strict TypeScript settings.
- Fresh legacy exact-input simulation and v2 WSOL exact-input buy/sell passed.
- Fresh legacy and v2 exact-output roundtrips passed; decoded bought/sold token amounts matched. Insufficient maximum cost and impossible minimum proceeds produced the expected program errors at the trade instruction.
- V3 SOL roundtrip passed after correcting the harness to identify v3 from invocation logs. Both events used the zero fee-recipient marker; the final witness includes nonzero fee fields. This does not reconcile retained account balances.
- Executor Jito proto load initially failed: ESM splitting placed the loader in `dist/`, while assets are in `dist/proto/`. Corrected module-relative resolution for source, split ESM, and standalone CJS layouts. Rebuilt ESM and CJS smoke checks both pass, and CI now retains a separate CJS smoke gate. Executor source tests, coverage, typecheck and lint were rerun after this fix.
- Fresh PumpSwap effective-reserve sell check passed. This observes recent transactions; it does not execute every PumpSwap builder.
- The complete coverage command stops at an additional, untouched `pumpfun-signals` gate: all 18 active tests pass, but branch coverage is 76.19%, below 80%. No thresholds were lowered. Full normal CI is therefore **not yet green**; later packages in that command are not certified by this run.

`live-witness.json` retains decoded simulated events, expected rejections, and deployment observations. Failed simulation logs may include events from instructions executed before a later failure; these are not landed transactions and have no committed effects. The initial stricter harness incorrectly classified empty-payload invocations as event failures; corrected by matching the existing diagnostic's payload filter. All actual payloads in accepted witnesses decoded.

Remaining live qualification work:

- Nested quote creation, migrated quote-chain groups, custom-quote v2/v3, multi-hop routes, and synthetic migration/partial fills.
- A complete classic-token/Token-2022, cashback, mayhem, holder-reward and fee-tier matrix. Random recent witnesses do not establish this matrix.
- Fee transfer/account-balance reconciliation, nonzero v3 retained fees and sweeps, dynamic fee-tier boundary/rounding behavior. Decoding fee fields and passing a small trade do not prove those economics. Existing scalar-fee math helpers are not full dynamic-fee quotes.
- Every new account extension and instruction, including Pump Fees changes. IDL equality does not prove the deployed binary implements all documented behavior.
- Hosted Node 20 Ubuntu/Windows CI and the independent signals coverage deficit.

The upgrade utility reports mismatches; it is not an automatic check inside every raw builder or the generic executor. Callers must enforce their execution policy. This patch does not certify funded execution or advance any verified slot. No wallet key, funded trade, or transaction submission was used.

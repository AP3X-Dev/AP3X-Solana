# Public IDL refresh

The owner authorized I2 in the 2026-10-08 23:25 steering. This work uses an isolated worktree on feat/pumpfun-idl-refresh, based on ee350bbe. No main branch or existing checkout was changed.

The vendored files are the exact pump.json and pump_amm.json from [pump-public-docs commit 2293f9a66c654e9fe82dc5e8f4618538f24bb35f](https://github.com/pump-fun/pump-public-docs/commit/2293f9a66c654e9fe82dc5e8f4618538f24bb35f). Generated schemas include the five new event discriminators, requested v2/v3 and multi-hop instruction layouts, and appended account fields. Nested instruction argument types are included. Legacy builder bytes remain identical when optional trailing partial_fill is omitted; explicit true/false is encoded when supplied through the IDL builder. Nothing is sent.

Short accounts preserve their available field prefix. Mid-field truncations remain malformed. Retained 151-byte curve and 301-byte pool allocations include padding that cannot establish new fee counters; their default projection carries layoutVersion unknown and omits the new fields. Explicit layoutVersion selects the previous or current layout. QuoteControl keeps the same overall size while replacing reserved bytes with reserves_admin. Without version evidence, only unchanged admin/mints fields are returned. Padding never establishes an administrator.

New controlled fixtures exercise all additions, malformed prefixes, historical padding and explicit version selection. Existing retained mainnet instruction fixtures remain unchanged and pass. New decoded facts are optional when original bytes do not establish them; they never default to guessed zero. Live program/IDL deployment coverage and new instruction execution economics remain unqualified.

Build, typecheck and lint pass with zero lint errors; baseline warnings remain. The initial broad test run found a missing SQLite native binding in this newly installed worktree; its existing install script restored that dependency. No assertion was removed or weakened. The full library test run passes all 38 tasks, including 61 event and 103 protocol tests. Final library and precommit test evidence is in the engine worktree's archive/i2-library-tests-20261009.log and archive/i2-precommit-tests-20261009.log.

No live witness or simulation was run. Spend cap: USD 0. No TypeSafe, Solana RPC, signing or trading call was made. Skipped live/fixture-dependent checks retain their previous qualification boundary. The owner handles integration and merging.

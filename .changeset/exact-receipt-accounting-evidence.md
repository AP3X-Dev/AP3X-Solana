---
"@ap3x/solana-core": minor
"@ap3x/solana-portfolio": patch
"@ap3x/solana-strategy": patch
---

Add rpcU64 for exact RPC quantity validation. Bind landed receipts to their
signature, slot and successful execution; refuse incomplete quantities and sum
all owned token accounts once. Stop historical basis reconstruction at missing
or incomplete receipt evidence, preserving unresolved opening inventory.

Report execution/receipt/accounting failures through StrategyRuntime's existing
error and guard path using the execution phase, preventing unhandled background
rejections.
Queued decisions recheck quarantine before executing after a guard trip.

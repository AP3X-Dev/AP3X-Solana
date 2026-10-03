---
'@ap3x/solana-tx': patch
---

Fix: `assemble` and `compileUnsigned` no longer resolve an invoked program through an address lookup table, which the runtime rejects. Programs stay static keys.

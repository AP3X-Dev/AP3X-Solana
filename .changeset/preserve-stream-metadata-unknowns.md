---
"@ap3x/solana-connectivity": patch
---

Keep omitted stream execution status unknown, allow a later known notification
after an unknown one, and withhold full-transaction metadata when its fee is
missing or inexact instead of inventing a zero fee.

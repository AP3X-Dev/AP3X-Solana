---
'@ap3x/pumpfun-protocol': minor
---

Fix: PumpSwap `quoteReserves` is now the effective reserve the program prices with (quote vault balance + `virtualQuoteReserves`); the raw balance moves to `quoteVaultBalance`. Pools with virtual quote reserves were mispriced before.

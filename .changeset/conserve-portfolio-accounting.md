---
'@ap3x/solana-portfolio': patch
---

Recognize all proceeds from partial FIFO/LIFO sales. Conserve exact token amounts
and remaining basis when average-cost reductions round across multiple lots, and
retain unresolved-basis status across pooled allocations.

Make repeated reconciler starts idempotent so stopping releases every timer.

Reject invalid accounting methods, negative or inexact quantities/prices/basis,
zero-sized lots, sale proceeds without sold quantity, and invalid manual basis
corrections rather than returning or persisting misleading accounting values.

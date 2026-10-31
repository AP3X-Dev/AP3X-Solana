---
"@ap3x/solana-events": minor
---

Expose receipt-bound runtime invocation mapping. Keep log-root ordinals separate
from RPC outer instruction indices, require a unique ordered program/depth/parent
match, and propagate ancestor rollback and unknown transaction execution. Preserve
event payload bytes and leave truncated, malformed or ambiguous traces unresolved.

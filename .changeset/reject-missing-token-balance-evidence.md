---
'@ap3x/solana-portfolio': patch
---

Reject unavailable or malformed token-account RPC responses instead of treating
them as zero balances. Require exact raw u64 amount strings and valid mint keys
before reconciling, preventing false drift and destructive zero-balance rebuilds
when either token program's balance evidence is unavailable.

Background reconciler failures are reported through an optional onError callback
(stderr by default), avoiding unhandled promise rejections; direct runOnce calls
still reject so callers cannot mistake a failed pass for a successful check.

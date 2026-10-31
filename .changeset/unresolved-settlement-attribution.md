---
"@ap3x/solana-portfolio": minor
"@ap3x/solana-strategy": minor
---

Keep multi-mint receipt cash allocation unresolved instead of assigning the same
net SOL change to every mint. Preserve all token quantities, expose attribution
status for recorded PnL, and retain unresolved proceeds/basis across restart.
Numeric PnL reads reject unresolved amounts; explicit, audited settlement
resolutions are idempotent and cannot contradict already known facts.

Receipt aggregate replays are idempotent. Persist bigint values with explicit
tags while reading old numeric fields without confusing base58 identifiers for
numbers. Strategies record all receipt quantities before evaluating PnL guards;
configured PnL limits require resolved accounting. Backtests refuse to score
unresolved settlement amounts.

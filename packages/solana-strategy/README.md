# @ap3x/solana-strategy

Strategy layer for the AP3X Solana runtime. Provides the `Strategy` abstract class and `SignalFilter` matcher that every concrete trading strategy extends.

Receipt adaptation retains all owned token changes. When multiple mints change,
per-mint cash flow is `null`; the receipt's net SOL observation is retained
separately. Exact settlement still requires instruction/event attribution, and
the single-mint net-SOL fallback is not universal proof of acquisition cost.

The runtime records all receipt aggregates before evaluating PnL. Configured loss
or drawdown limits require resolved accounting, checked before submission and
after recording a fill. `guards.requireCompleteAccounting: true` enables the
same requirement without PnL limits. Without those requirements, inventory
tracking continues while PnL remains explicitly unresolved. Backtests refuse
to produce scores for unresolved settlement cash flow.

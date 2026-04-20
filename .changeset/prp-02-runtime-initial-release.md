---
'@ap3x/solana-signals': minor
'@ap3x/solana-strategy': minor
'@ap3x/solana-executor': minor
'@ap3x/solana-portfolio': minor
---

Initial release of the PRP-02 Solana runtime packages:

- **@ap3x/solana-signals** — signal ingestion layer. SignalSource interface with three implementations (Fixture, Historical, Geyser), a dedup + overflow-safe SignalQueue, and durable FileSignalCheckpointStore for restart recovery.
- **@ap3x/solana-strategy** — strategy runtime. Strategy abstract class (8-hook API), declarative SignalFilter, per-instance dispatch queue for FIFO serialization, GuardTracker for rate/loss/error limits, intentId derivation, FileStrategyStateStore, runBacktest harness (gate-6 byte-identical determinism), and the StrategyRuntime orchestrator wiring signals → strategies → executor → portfolio.
- **@ap3x/solana-executor** — decision → on-chain. Executor.submit with idempotency (InFlightMap), compute-budget telemetry, vault-mediated signing (resolveWallet seam), three submitters (RpcSubmitter, JitoHttpSubmitter, JitoGrpcSubmitter with vendored protos), BundleAccumulator (50ms / 5 intent window), failover chain with fee-tier bump progression, and uniform ExecutionResult envelope.
- **@ap3x/solana-portfolio** — position + cost-basis tracking. FilePortfolioStore with FIFO reduction + atomic tmp+rename, SwapTracerRegistry for per-venue trade classification, CostBasisReconstructor for cold-start wallet recovery, Reconciler for drift detection, daily-close append-only writer, and `ap3x-portfolio correct-basis` CLI.

All four packages share the substrate posture: zero runtime deps on `@solana/web3.js`, `@solana/spl-token`, `@metaplex-foundation/*`. Only `@noble/ed25519` + `libsodium-wrappers` permitted.

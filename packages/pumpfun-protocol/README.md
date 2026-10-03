# @ap3x/pumpfun-protocol

Pump.fun protocol primitives — PDA derivation, on-chain account readers, and instruction builders for the pump.fun bonding curve and PumpSwap AMM programs. Sits on top of `@ap3x/pumpfun-events` (program IDs, Borsh helpers) and the substrate packages (`solana-core`, `solana-connectivity`, `solana-tx`, `solana-spl`, `solana-metaplex`). All readers are stateless; each call is an independent RPC round-trip.

## v2 bonding-curve instructions

`buildBuyV2`, `buildBuyExactQuoteInV2` and `buildSellV2` build pump.fun's quote-mint-aware trades. On a SOL curve the quote is WSOL and the user's WSOL account must hold it: create the ATA, transfer SOL in, `syncNativeIx`, trade, then `closeAccountIx`. Measured on mainnet (2026-10-03) that costs about 1,071 bytes and 114k compute units against 768 bytes and 72k for the legacy `buildBuyExactSolIn`, so prefer the legacy instructions for SOL curves.

## Program-upgrade check

`checkProgramUpgrades(rpcPool)` compares each program's last-deployed slot (`programDeploySlot`, which reads only the 12-byte ProgramData header) with `VERIFIED_DEPLOYS`, the deployments the vendored IDLs were last verified against. A program with `upgraded: true` may have changed its accounts or instructions: stop building trades for it until the IDLs are re-verified and `VERIFIED_DEPLOYS` is updated. The opt-in `tests/live-simulation.test.ts` (`AP3X_LIVE_RPC=<mainnet rpc>`) checks both.

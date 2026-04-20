# @ap3x/pumpfun-protocol

Pump.fun protocol primitives — PDA derivation, on-chain account readers, and instruction builders for the pump.fun bonding curve and PumpSwap AMM programs. Sits on top of `@ap3x/pumpfun-events` (program IDs, Borsh helpers) and the substrate packages (`solana-core`, `solana-connectivity`, `solana-tx`, `solana-spl`, `solana-metaplex`). All readers are stateless; each call is an independent RPC round-trip.

# @ap3x/pumpfun-events

Program ID constants and log/CPI decoders for the pump.fun bonding curve and PumpSwap AMM programs. Registers decoders into `@ap3x/solana-events`' `EventDecoderRegistry` so downstream consumers (signals, strategies, the pumpfun-watch example) can surface typed pump.fun lifecycle events from generic transaction log and CPI streams. All decoders are stateless pure functions — no runtime state, no network I/O — and unknown instruction/event variants surface as typed `UnknownEventDecode` records rather than being silently dropped.

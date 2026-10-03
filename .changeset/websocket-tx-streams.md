---
'@ap3x/solana-connectivity': minor
---

Add WebSocket transaction streams: `subscribeHeliusTransactions` (Helius Enhanced WebSockets `transactionSubscribe`) and `subscribeProgramLogs` (standard `logsSubscribe` across several programs). Both reconnect with backoff, report the last slot seen on reconnect, and reject on a failed first subscription so callers can fall back.

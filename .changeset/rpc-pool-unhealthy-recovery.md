---
"@ap3x/solana-connectivity": patch
---

RpcPool: unhealthy endpoints recover. After 10 consecutive errors an endpoint was never picked again, so it could never record the success that resets it; a single-endpoint pool stayed down for the life of the process. It now gets one probe call after a cooldown (5 s, doubling per failed probe up to 60 s).

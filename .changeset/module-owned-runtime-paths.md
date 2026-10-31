---
'@ap3x/solana-executor': patch
'@ap3x/solana-connectivity': patch
'@ap3x/solana-vault': patch
---

Resolve ESM runtime assets and CommonJS dependencies from the imported module URL
before considering CommonJS globals exposed by node -e. Keep CommonJS fallback
paths local to the bundle and test packed dynamic imports from a CommonJS caller.

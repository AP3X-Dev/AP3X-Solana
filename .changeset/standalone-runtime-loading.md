---
"@ap3x/solana-executor": patch
"@ap3x/solana-vault": patch
---

Resolve Jito proto assets in source, bundled ESM and CommonJS layouts without depending on the caller's working directory. Load the public CommonJS libsodium sumo export from both vault module formats so standalone npm consumers do not require the workspace-only ESM dependency patch. Preserve Argon2id and the existing encrypted-vault format.

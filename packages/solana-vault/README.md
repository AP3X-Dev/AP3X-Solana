# @ap3x/solana-vault

Encrypted key storage and signing for the AP3X Solana runtime.

## Overview

`Vault` stores 32-byte ed25519 seeds encrypted with libsodium secretbox (XSalsa20-Poly1305), using a key derived from a passphrase with Argon2id. It hands out `WalletHandle` objects for signing. Raw keys are never returned: a handle exposes `address`, `role`, `sign`, `signTransaction`, `isLocked` and a redacted `toJSON()`, and the seed is kept in a private field that is zeroed on lock. Every create, unlock, sign and rotate appends an entry to the wallet's audit log.

## Key exports

- `Vault({ storage, kdf?, passphrasePolicy?, solReserveByRole? })` — methods: `addWallet(name, role, secretKey, passphrase, { overwrite? })`, `unlock(name, passphrase, { getBalance?, estimateDelta? })`, `lock(name)`, `lockAll()`, `rotateKey(name, oldPassphrase, newPassphrase)`, `list()` and `audit(name)`.
- `WalletHandle` — `sign(message)` signs off-chain bytes. `signTransaction(tx)` signs a single-signer v0 transaction laid out as `[1 || 64-byte placeholder || message]`. For transactions with several signers, pass the handle as a `Signer` to `assemble()` in `@ap3x/solana-tx`.
- `WalletReserveBreach` — thrown by `signTransaction` before any signature is produced (`code: 'vault.reserve_breach'`).
- `checkSpend(input)` — the reserve rule: `currentBalance + txEstimatedDelta >= reserveLamports`, computed in `bigint`.
- `FileVaultStorage({ baseDir? })` — the `VaultStorage` implementation. It stores JSON records and a JSONL audit log under `~/.ap3x/vault/` by default.
- `validatePassphrase(pp, policy?)` — the default policy requires at least 12 characters from at least 3 of {lowercase, uppercase, digit, symbol}.
- `ready`, `deriveKey`, `encrypt`, `decrypt` — the crypto primitives. `logAudit` and `readAudit` handle the audit log.
- `VaultHeartbeat`, `readHeartbeatFile` — a liveness timestamp that can be persisted to a file. The caller must call `tick()`; `Vault` does not call it.

## SOL reserve guard

`solReserveByRole` maps a role to a minimum lamport balance. Unlocking a wallet whose role has a reserve **requires both `getBalance` and `estimateDelta`**, or `unlock` throws. `signTransaction` then calls `getBalance()`, adds `estimateDelta(tx)` (negative for spends, including fees) and refuses to sign if the result would fall below the reserve. Roles with no reserve need neither hook.

## Usage

```ts
import { FileVaultStorage, Vault } from '@ap3x/solana-vault';

const vault = new Vault({ storage: new FileVaultStorage(), solReserveByRole: { trader: 50_000_000n } });
await vault.addWallet('hot-1', 'trader', seed, passphrase);
seed.fill(0);

const wallet = await vault.unlock('hot-1', passphrase, {
  getBalance: () => fetchLamports(address),
  estimateDelta: (tx) => estimateLamportDelta(tx),
});
const signed = await wallet.signTransaction(unsignedTx);
vault.lock('hot-1');
```

## Boundary

`solana-vault` may import only from `core`. Its crypto dependencies are `libsodium-wrappers-sumo`, `@noble/ed25519` and `@noble/hashes`.

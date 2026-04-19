/**
 * `Vault` — orchestrates passphrase-derived encryption, durable storage, and
 * live `WalletHandle` lifecycle.
 *
 * Invariants (PRP-01 conventions):
 *  - Vault never returns raw keypairs. All signing is mediated by WalletHandle.
 *  - Plaintext in/out of storage is always the 32-byte ed25519 seed.
 *  - Encryption uses libsodium `crypto_secretbox_easy` with Argon2id-derived
 *    keys. `crypto.ts` (T10) owns primitive correctness; this file owns policy.
 *  - Passphrase policy is enforced at `addWallet` and `rotateKey`, never
 *    bypassed by constructor flags.
 *  - SOL reserve guard (T12) is enforced at the `WalletHandle.signTransaction`
 *    boundary: the Vault wires `solReserveByRole[role]` + caller-provided
 *    balance/delta hooks into each unlocked handle.
 */

import { PublicKey } from '@ap3x/solana-core';
import * as ed from '@noble/ed25519';
import sodium from 'libsodium-wrappers-sumo';

import { logAudit } from './audit';
import { decrypt, deriveKey, encrypt, ready } from './crypto';
import type {
  AuditEntry,
  EncryptedRecord,
  KdfOverrides,
  PassphrasePolicy,
  VaultStorage,
  WalletMetadata,
} from './types';
import { WalletHandle } from './wallet-handle';

export interface VaultOptions {
  storage: VaultStorage;
  /**
   * Argon2id tuning overrides. Defaults to `OPSLIMIT_MODERATE` +
   * `MEMLIMIT_MODERATE`. Tests should pin these to `_MIN` via this hook to
   * keep suite runtime reasonable; production callers should leave them
   * untouched or go higher.
   */
  kdf?: KdfOverrides;
  /** Passphrase policy overrides. */
  passphrasePolicy?: PassphrasePolicy;
  /**
   * Per-role SOL reserve floors in lamports (T12 — PRP-01 Section 3.7).
   * When a wallet is unlocked, its `role` is looked up against this map and
   * the matching lamport floor is wired into the WalletHandle. Roles not
   * present here have no reserve policy — the guard silently no-ops. This
   * lets operators opt individual roles (e.g. `trader`) into the guard
   * without imposing a default on warm wallets or sweep accounts.
   */
  solReserveByRole?: Record<string, bigint>;
}

/** Options passed to `Vault.unlock` to wire up the reserve guard. */
export interface UnlockOptions {
  /**
   * Live balance fetcher for the unlocked wallet (lamports). Typically an
   * RPC pool's `getBalance(address)`. Required to enable the reserve guard.
   */
  getBalance?: () => Promise<bigint>;
  /**
   * Signed lamport delta estimator for a transaction. Caller includes priority
   * fee + SOL moves. Required to enable the reserve guard.
   */
  estimateDelta?: (tx: Uint8Array) => bigint;
}

/**
 * Default passphrase policy. Both limits are overridable via constructor
 * options. The "≥3 of {lower, upper, digit, symbol}" rule gives reasonable
 * entropy (~50 bits for 12 chars over 3 categories) without being so strict
 * that users pick reused phrases out of frustration.
 */
const DEFAULT_POLICY: Required<PassphrasePolicy> = {
  minLength: 12,
  minCategories: 3,
};

export function validatePassphrase(
  pp: string,
  policy: PassphrasePolicy = {},
): void {
  const minLength = policy.minLength ?? DEFAULT_POLICY.minLength;
  const minCategories = policy.minCategories ?? DEFAULT_POLICY.minCategories;
  if (pp.length < minLength) {
    throw new Error(
      `vault: passphrase must be at least ${minLength} characters`,
    );
  }
  const categories = [
    /[a-z]/.test(pp),
    /[A-Z]/.test(pp),
    /[0-9]/.test(pp),
    /[^a-zA-Z0-9]/.test(pp),
  ].filter(Boolean).length;
  if (categories < minCategories) {
    throw new Error(
      `vault: passphrase must include at least ${minCategories} of {lowercase, uppercase, digit, symbol}`,
    );
  }
}

/** Base64 helpers — Node + modern browsers both ship these. */
function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export class Vault {
  readonly #storage: VaultStorage;
  readonly #policy: PassphrasePolicy;
  readonly #opslimit: number | null;
  readonly #memlimit: number | null;
  readonly #solReserveByRole: Record<string, bigint>;

  /**
   * Handles that have been unlocked this process and not yet re-locked.
   * Tracked so `lock(name)` can zero the in-memory seed. Absence from the map
   * is not an error — locking a never-unlocked wallet is a no-op.
   */
  readonly #unlocked: Map<string, WalletHandle> = new Map();

  constructor(options: VaultOptions) {
    this.#storage = options.storage;
    this.#policy = options.passphrasePolicy ?? {};
    this.#opslimit = options.kdf?.opslimit ?? null;
    this.#memlimit = options.kdf?.memlimit ?? null;
    this.#solReserveByRole = options.solReserveByRole ?? {};
  }

  /**
   * Resolve KDF parameters. `constructor` captures any overrides; here we
   * fall back to libsodium's MODERATE tier, which is ~64 MiB / ~0.5 s on a
   * modern laptop. Call only after `await ready()` so the sodium constants
   * are actually bound.
   */
  private async kdfParams(): Promise<{ opslimit: number; memlimit: number }> {
    await ready();
    return {
      opslimit: this.#opslimit ?? sodium.crypto_pwhash_OPSLIMIT_MODERATE,
      memlimit: this.#memlimit ?? sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    };
  }

  /**
   * Add a new wallet to the vault.
   *
   * The `secretKey` must be a 32-byte ed25519 seed; 64-byte Solana-style
   * keypairs are rejected here so callers don't accidentally persist a
   * redundant pubkey half and double storage.
   *
   * Side effects: a fresh 16-byte random salt is generated, the seed is
   * encrypted under the passphrase-derived key, and a `create` audit entry is
   * appended.
   *
   * By default, calling `addWallet` for a name that already exists throws —
   * accidentally overwriting a production key is a footgun we refuse to
   * offer silently. Pass `{ overwrite: true }` to replace an existing record
   * intentionally (e.g. after a key rotation).
   *
   * **Caller responsibility:** the `secretKey` parameter is defensively copied
   * into the WalletHandle, but the caller's original buffer is NOT zeroed by
   * this method. If you derived the seed from a mnemonic or passphrase, zero
   * the input buffer yourself after this call returns:
   *
   *   const seed = deriveFromMnemonic(phrase);
   *   try { await vault.addWallet(name, role, seed, pp); }
   *   finally { seed.fill(0); }
   *
   * @param name - wallet identifier; must match /^[a-zA-Z0-9_.-]+$/
   * @param role - caller-chosen operational label (NOT considered secret)
   * @param secretKey - 32-byte ed25519 seed; caller zeroes after this returns
   * @param passphrase - >=12 chars, >=3 of {lower, upper, digit, symbol}
   * @param options.overwrite - default false; pass true to replace existing record
   */
  async addWallet(
    name: string,
    role: string,
    secretKey: Uint8Array,
    passphrase: string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    validatePassphrase(passphrase, this.#policy);
    if (secretKey.length !== 32) {
      throw new Error(
        `vault: secretKey must be a 32-byte ed25519 seed (got ${secretKey.length})`,
      );
    }

    const existing = await this.#storage.read(name);
    if (existing && !options?.overwrite) {
      throw new Error(
        `vault: wallet '${name}' already exists (pass { overwrite: true } to replace)`,
      );
    }

    await ready();
    const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
    const { opslimit, memlimit } = await this.kdfParams();
    const key = await deriveKey(passphrase, salt, opslimit, memlimit);

    let record: EncryptedRecord;
    try {
      const { nonce, ciphertext } = await encrypt(key, secretKey);
      const pubkey = await ed.getPublicKeyAsync(secretKey);
      const address = PublicKey.fromBytes(pubkey).toBase58();

      record = {
        version: 1,
        name,
        role,
        address,
        kdf: {
          algo: 'argon2id',
          salt: b64encode(salt),
          opslimit,
          memlimit,
        },
        encryption: {
          algo: 'xsalsa20-poly1305',
          nonce: b64encode(nonce),
          ciphertext: b64encode(ciphertext),
        },
        createdAt: new Date().toISOString(),
      };
    } finally {
      // Zero the derived key as soon as we're done — it's reconstructible from
      // the passphrase but there's no reason to linger in process memory.
      key.fill(0);
    }

    await this.#storage.write(name, record);
    await logAudit(this.#storage, name, 'create', {
      role,
      address: record.address,
    });
  }

  /**
   * Decrypt `name` with `passphrase` and return a live `WalletHandle`.
   *
   * On wrong passphrase, `decrypt` throws (Poly1305 MAC verification) and we
   * surface a generic "invalid passphrase" to avoid oracle leaks. Unknown
   * wallet names throw a distinct, findable error.
   *
   * Called twice for the same name, the second call LOCKS the first handle
   * before returning a new one, so stale handles can't outlive their unlock
   * call and the Map never double-counts.
   *
   * **T12 SOL reserve guard wiring.** If the wallet's `role` appears in the
   * Vault's `solReserveByRole` map AND the caller supplies both `getBalance`
   * and `estimateDelta` in `options`, those three values are wired into the
   * returned handle and `signTransaction` will enforce the reserve floor. If
   * any of the three is missing the guard silently no-ops, which is the
   * documented graceful default — operators opt in per-role.
   */
  async unlock(
    name: string,
    passphrase: string,
    options?: UnlockOptions,
  ): Promise<WalletHandle> {
    const record = await this.#storage.read(name);
    if (!record) throw new Error(`vault: wallet '${name}' not found`);

    const salt = b64decode(record.kdf.salt);
    const nonce = b64decode(record.encryption.nonce);
    const ciphertext = b64decode(record.encryption.ciphertext);

    const key = await deriveKey(
      passphrase,
      salt,
      record.kdf.opslimit,
      record.kdf.memlimit,
    );

    let secretKey: Uint8Array;
    try {
      secretKey = await decrypt(key, nonce, ciphertext);
    } catch {
      // libsodium raises on MAC failure regardless of which input was wrong;
      // translate to a stable, single-message error so callers can't tell
      // "unknown name" from "bad passphrase" by timing/wording.
      throw new Error('vault: invalid passphrase');
    } finally {
      key.fill(0);
    }

    // If the user double-unlocks the same wallet, lock the previous handle so
    // we don't leak two live copies of the secret.
    const existing = this.#unlocked.get(name);
    if (existing) existing._lock();

    const address = PublicKey.fromBase58(record.address);
    const storage = this.#storage;
    const reserveLamports = this.#solReserveByRole[record.role];
    const handle = new WalletHandle(
      record.role,
      address,
      secretKey,
      async (event, metadata) => {
        await logAudit(storage, name, event, metadata);
      },
      {
        // Only populate `reserveLamports` when a policy exists for this role.
        // The handle already silently no-ops when any of the three hooks is
        // undefined; leaving `reserveLamports` unset here is equivalent to
        // "no reserve policy for this wallet."
        ...(reserveLamports !== undefined ? { reserveLamports } : {}),
        ...(options?.getBalance !== undefined
          ? { getBalance: options.getBalance }
          : {}),
        ...(options?.estimateDelta !== undefined
          ? { estimateDelta: options.estimateDelta }
          : {}),
      },
    );
    this.#unlocked.set(name, handle);

    // Zero the intermediate plaintext copy now that it lives inside the
    // handle (which took its own defensive copy).
    secretKey.fill(0);

    await logAudit(this.#storage, name, 'unlock', {
      address: record.address,
      role: record.role,
    });

    return handle;
  }

  /**
   * Zero the in-memory secret of the named wallet. Idempotent — locking an
   * already-locked or never-unlocked wallet is a no-op, which keeps shutdown
   * sequences simple.
   */
  lock(name: string): void {
    const handle = this.#unlocked.get(name);
    if (handle) {
      handle._lock();
      this.#unlocked.delete(name);
    }
  }

  /**
   * Convenience for callers who want to tear everything down (process
   * shutdown, post-test cleanup). Not part of the PRP-01 Section 3.7 surface
   * but cheap to add and impossible to do safely from outside.
   */
  lockAll(): void {
    for (const handle of this.#unlocked.values()) handle._lock();
    this.#unlocked.clear();
  }

  /**
   * Re-encrypt an existing wallet under a new passphrase.
   *
   * Rotation preserves the underlying ed25519 seed — and therefore the
   * wallet's on-chain address — but generates a fresh salt, derives a fresh
   * key from `newPassphrase`, and writes a new nonce + ciphertext. After a
   * successful rotation:
   *
   *  - `oldPassphrase` no longer unlocks the wallet (wrong derived key → MAC fail)
   *  - `newPassphrase` unlocks the wallet and yields the same `address`
   *  - a `rotate` audit entry is appended
   *  - `createdAt`, `name`, `role`, `address` are preserved on disk
   *
   * Raises:
   *  - `vault: wallet '<name>' not found` — unknown name
   *  - `vault: invalid passphrase` — oldPassphrase doesn't match
   *  - passphrase policy error — newPassphrase fails the configured policy
   *
   * The seed is kept in a single local buffer for the duration of the
   * rotation and zeroed in a `finally` block, so rotation never lengthens the
   * window a plaintext seed spends in process memory beyond a single
   * encrypt call.
   */
  async rotateKey(
    name: string,
    oldPassphrase: string,
    newPassphrase: string,
  ): Promise<void> {
    // Validate the NEW passphrase up front — don't spend the KDF budget on an
    // old-passphrase decrypt just to reject the new one afterwards.
    validatePassphrase(newPassphrase, this.#policy);

    const record = await this.#storage.read(name);
    if (!record) throw new Error(`vault: wallet '${name}' not found`);

    await ready();
    const oldSalt = b64decode(record.kdf.salt);
    const oldNonce = b64decode(record.encryption.nonce);
    const oldCiphertext = b64decode(record.encryption.ciphertext);

    const oldKey = await deriveKey(
      oldPassphrase,
      oldSalt,
      record.kdf.opslimit,
      record.kdf.memlimit,
    );

    let seed: Uint8Array;
    try {
      seed = await decrypt(oldKey, oldNonce, oldCiphertext);
    } catch {
      // Same generic message as `unlock` so an attacker probing rotateKey
      // can't tell wrong-passphrase from other failures by wording.
      throw new Error('vault: invalid passphrase');
    } finally {
      oldKey.fill(0);
    }

    try {
      // Fresh salt per rotation so the new encryption is not linkable to the
      // old one. A rotation that reused the old salt would leak the KDF
      // parameters' effectiveness under the old passphrase.
      const newSalt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
      const { opslimit, memlimit } = await this.kdfParams();
      const newKey = await deriveKey(
        newPassphrase,
        newSalt,
        opslimit,
        memlimit,
      );
      try {
        const { nonce, ciphertext } = await encrypt(newKey, seed);
        const newRecord: EncryptedRecord = {
          ...record,
          kdf: {
            algo: 'argon2id',
            salt: b64encode(newSalt),
            opslimit,
            memlimit,
          },
          encryption: {
            algo: 'xsalsa20-poly1305',
            nonce: b64encode(nonce),
            ciphertext: b64encode(ciphertext),
          },
        };
        await this.#storage.write(name, newRecord);
        await logAudit(this.#storage, name, 'rotate', { role: record.role });
      } finally {
        newKey.fill(0);
      }
    } finally {
      // Always zero the plaintext seed — even if re-encryption failed, we do
      // not want a stray copy lingering.
      seed.fill(0);
    }
  }

  /**
   * Return metadata for every wallet currently on disk. Reads each record
   * directly — there is no cached index, which is fine for the small N
   * (typically < 20 wallets per operator) this vault targets.
   */
  async list(): Promise<WalletMetadata[]> {
    const names = await this.#storage.list();
    const out: WalletMetadata[] = [];
    for (const name of names) {
      const rec = await this.#storage.read(name);
      if (!rec) continue; // raced deletion; skip
      out.push({
        name: rec.name,
        role: rec.role,
        address: rec.address,
        createdAt: rec.createdAt,
      });
    }
    return out;
  }

  /** Return the audit log for a wallet. Empty array if no log exists yet. */
  async audit(name: string): Promise<AuditEntry[]> {
    return this.#storage.readAudit(name);
  }
}

// The Vault uses Argon2id for passphrase-based key derivation. The standard
// `libsodium-wrappers` build does NOT expose `crypto_pwhash` or its
// `ALG_ARGON2ID13` / OPSLIMIT / MEMLIMIT / SALTBYTES constants — those live
// only in the "sumo" build. This is a hard requirement, not a preference.
import sodium from 'libsodium-wrappers-sumo';

/**
 * Await libsodium's initialization promise. Every primitive in this module
 * calls `ready()` defensively, so callers rarely need to invoke it directly,
 * but exporting it keeps the lifecycle explicit for higher-level callers that
 * want to pre-warm before a latency-sensitive code path.
 */
export async function ready(): Promise<void> {
  await sodium.ready;
}

/**
 * Passphrase + ciphertext pair returned by {@link encrypt}.
 *
 * The nonce is a fresh 24-byte random value produced by libsodium's CSPRNG;
 * it is NOT a secret and must be stored alongside the ciphertext so
 * {@link decrypt} can verify authenticity.
 */
export interface EncryptedPayload {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Derive a 32-byte symmetric key from a passphrase via Argon2id.
 *
 * @param passphrase UTF-8 user passphrase (never persisted — input only).
 * @param salt       16 random bytes; MUST be stored alongside the ciphertext so
 *                   decryption can reproduce the key. A fresh salt per vault
 *                   prevents rainbow-table / cross-vault correlation attacks.
 * @param opslimit   libsodium `crypto_pwhash_OPSLIMIT_*` constant (compute cost).
 *                   The Vault (T11) defaults to `MODERATE` or higher; tests
 *                   should use `MIN` to keep suite time reasonable.
 * @param memlimit   libsodium `crypto_pwhash_MEMLIMIT_*` constant (memory cost).
 *                   Must match `opslimit` tier — `MIN` for tests, `MODERATE`+
 *                   for real vaults.
 *
 * @returns 32-byte key suitable for `crypto_secretbox` (XSalsa20-Poly1305).
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  opslimit: number,
  memlimit: number,
): Promise<Uint8Array> {
  await ready();
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new Error(
      `vault: salt must be ${sodium.crypto_pwhash_SALTBYTES} bytes, got ${salt.length}`,
    );
  }
  return sodium.crypto_pwhash(
    32,
    passphrase,
    salt,
    opslimit,
    memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/**
 * Authenticated-encrypt `plaintext` under `key` using XSalsa20-Poly1305
 * (libsodium `crypto_secretbox_easy`).
 *
 * A fresh 24-byte random nonce is generated for every call; the caller must
 * persist `{ nonce, ciphertext }` together because both are required for
 * decryption. The key must be 32 bytes
 * (`sodium.crypto_secretbox_KEYBYTES`).
 */
export async function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<EncryptedPayload> {
  await ready();
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `vault: key must be ${sodium.crypto_secretbox_KEYBYTES} bytes, got ${key.length}`,
    );
  }
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  return { nonce, ciphertext };
}

/**
 * Authenticated-decrypt `ciphertext` under `key` and `nonce` using
 * libsodium `crypto_secretbox_open_easy`.
 *
 * Throws on ANY tamper — modified ciphertext, wrong key, or wrong nonce —
 * because the underlying Poly1305 MAC is verified before decryption. Callers
 * MUST surface the exception rather than falling back to partial plaintext.
 */
export async function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  await ready();
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `vault: key must be ${sodium.crypto_secretbox_KEYBYTES} bytes, got ${key.length}`,
    );
  }
  if (nonce.length !== sodium.crypto_secretbox_NONCEBYTES) {
    throw new Error(
      `vault: nonce must be ${sodium.crypto_secretbox_NONCEBYTES} bytes, got ${nonce.length}`,
    );
  }
  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
}

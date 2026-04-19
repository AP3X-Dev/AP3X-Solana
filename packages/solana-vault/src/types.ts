/**
 * Shared type definitions for `@ap3x/solana-vault`. Defined in a separate
 * module to avoid circular imports between `vault.ts`, `storage-file.ts`, and
 * `wallet-handle.ts`.
 *
 * Mirrors PRP-01 Section 3.7 verbatim. Bumping `version` is a breaking change
 * — migrations live in a future T12 extension.
 */

/**
 * On-disk shape of an encrypted wallet record. Every field is stringified so
 * the JSON is portable across editors and version-control diffs are
 * human-reviewable (base64 for bytes, ISO 8601 for times).
 */
export interface EncryptedRecord {
  version: 1;
  name: string;
  role: string;
  /** base58-encoded 32-byte ed25519 public key. */
  address: string;
  kdf: {
    algo: 'argon2id';
    /** base64-encoded salt (libsodium crypto_pwhash_SALTBYTES). */
    salt: string;
    /** libsodium `crypto_pwhash_OPSLIMIT_*` value used at encryption time. */
    opslimit: number;
    /** libsodium `crypto_pwhash_MEMLIMIT_*` value used at encryption time. */
    memlimit: number;
  };
  encryption: {
    algo: 'xsalsa20-poly1305';
    /** base64-encoded 24-byte secretbox nonce. */
    nonce: string;
    /** base64-encoded ciphertext (plaintext = 32-byte ed25519 seed). */
    ciphertext: string;
  };
  /** ISO 8601 timestamp at creation. */
  createdAt: string;
}

/**
 * Single audit log entry. Stored one-per-line in the `<name>.audit.jsonl`
 * file. `metadata` is intentionally `unknown`-valued so future events can
 * evolve their payload without migration, but must remain JSON-serializable.
 */
export interface AuditEntry {
  timestamp: string;
  event: 'unlock' | 'sign' | 'rotate' | 'create';
  metadata?: Record<string, unknown>;
}

/** Public view of a stored wallet used by `Vault.list()`. */
export interface WalletMetadata {
  name: string;
  role: string;
  address: string;
  createdAt: string;
}

/**
 * Backend interface the Vault uses for persistence. `FileVaultStorage` is the
 * default; alternatives (in-memory for tests, KMS-backed for production) can
 * slot in without changes to the core Vault logic.
 */
export interface VaultStorage {
  read(name: string): Promise<EncryptedRecord | null>;
  write(name: string, rec: EncryptedRecord): Promise<void>;
  list(): Promise<string[]>;
  appendAudit(name: string, entry: AuditEntry): Promise<void>;
  readAudit(name: string): Promise<AuditEntry[]>;
}

/** Passphrase strength policy; see `validatePassphrase`. */
export interface PassphrasePolicy {
  /** Minimum character length (default 12). */
  minLength?: number;
  /**
   * Minimum number of character *categories* — {lower, upper, digit, symbol}
   * — that must appear (default 3).
   */
  minCategories?: number;
}

/** Advanced KDF overrides; defaults come from libsodium's MODERATE tier. */
export interface KdfOverrides {
  opslimit?: number;
  memlimit?: number;
}

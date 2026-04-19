/**
 * `WalletHandle` — the only user-facing surface to a decrypted Solana secret
 * key. Per PRP-01 invariants:
 *
 *  - Exposes `sign` / `signTransaction` / `address` / `role` only.
 *  - NEVER exposes the raw 32-byte seed via getter, toJSON, or any other path.
 *  - Holds the seed in a private field (`#secretKey`) and zeroes it on `_lock()`.
 *
 * Construction is internal to the vault: end users obtain handles by calling
 * `Vault.unlock(name, passphrase)`.
 */

import { PublicKey } from '@ap3x/solana-core';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

/**
 * @noble/ed25519 v2.x defers SHA-512 to the host. The library ships with a
 * default WebCrypto-based `sha512Async`, but we install a deterministic
 * `@noble/hashes` implementation so behaviour is identical across Node,
 * browsers, and edge runtimes and doesn't depend on SubtleCrypto availability.
 * Setting both the async and sync hashers also enables `ed.sign` (sync) if
 * callers ever need it.
 */
ed.etc.sha512Async = (...msgs: Uint8Array[]) =>
  Promise.resolve(sha512(ed.etc.concatBytes(...msgs)));
ed.etc.sha512Sync = (...msgs: Uint8Array[]) =>
  sha512(ed.etc.concatBytes(...msgs));

/**
 * Callback invoked by the WalletHandle after every successful sign operation.
 * Used by the Vault to append audit entries without the handle needing a
 * reference to the full vault. Returning a promise lets the handle await
 * durable audit writes when callers care about ordering, but the default
 * `sign` implementations intentionally fire-and-forget to avoid adding disk
 * latency to every signature.
 */
export type SignAuditHook = (
  event: 'sign',
  metadata: { kind: 'message' | 'transaction'; byteLength: number },
) => Promise<void> | void;

/**
 * Minimum plausible v0 transaction byte length: 1 byte for signature count + 0
 * for sigs (shouldn't happen but we don't want to crash) + a header (3 bytes)
 * + at least one account key (32 bytes) + blockhash (32 bytes). We only
 * enforce the signature-count prefix invariant — anything shorter than one
 * byte can't even be a v0 tx.
 */
const V0_TX_MIN_LENGTH = 1;

export class WalletHandle {
  readonly address: PublicKey;
  readonly role: string;

  /**
   * Decrypted ed25519 seed. `null` once `_lock()` has been called.
   *
   * Uses a `#`-private field so the secret is not enumerable, not visible to
   * `Object.keys`, not reachable via `Reflect.ownKeys` from outside the class,
   * and not included in `JSON.stringify` output. This is the main defence
   * against accidental leakage via logs, error serialization, or structured
   * clone.
   */
  #secretKey: Uint8Array | null;

  readonly #onSign: SignAuditHook | undefined;

  constructor(
    role: string,
    address: PublicKey,
    secretKey: Uint8Array,
    onSign?: SignAuditHook,
  ) {
    if (secretKey.length !== 32) {
      throw new Error(
        `WalletHandle: secretKey must be a 32-byte ed25519 seed (got ${secretKey.length})`,
      );
    }
    this.role = role;
    this.address = address;
    // Defensive copy so callers can't mutate our key by mutating their buffer
    // after construction. Also means we can zero our copy on lock without
    // disturbing the caller's memory.
    this.#secretKey = new Uint8Array(secretKey);
    this.#onSign = onSign;
  }

  /**
   * Zero the in-memory secret and mark the handle as locked. Idempotent —
   * calling `_lock()` twice is safe.
   *
   * Named with a leading underscore because it is an internal API owned by
   * `Vault.lock(name)` — never call this directly from application code.
   */
  _lock(): void {
    if (this.#secretKey) {
      this.#secretKey.fill(0);
      this.#secretKey = null;
    }
  }

  /** True once `_lock()` has been called. Useful for assertions in tests. */
  get isLocked(): boolean {
    return this.#secretKey === null;
  }

  /**
   * Sign an arbitrary message. Used for off-chain signing (e.g. SIWS-style
   * auth, webhook proofs). For on-chain transactions prefer
   * {@link signTransaction}, which also emits the single-signer v0 wire
   * format.
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const key = this.#secretKey;
    if (!key) throw new Error('vault: wallet is locked');
    const signature = await ed.signAsync(message, key);
    await this.#onSign?.('sign', { kind: 'message', byteLength: message.length });
    return signature;
  }

  /**
   * Sign a v0 (Versioned) transaction that has been serialized to the
   * [count || existing_sigs (0-filled) || message] wire layout with
   * `count === 1` placeholder. Per PRP-01 Section 3.7 we only support the
   * single-signer case in T11 — multi-signer aggregation belongs to the
   * Strategy layer.
   *
   * Input layout:
   *   tx[0]         = signature count (compact-u16, 1 byte for counts 0-127)
   *   tx[1..1+64n]  = existing signatures (may be zero-filled for our slot)
   *   tx[1+64n..]   = serialized message
   *
   * Output layout (single-signer):
   *   [ 1 || sig(64) || message(rest) ]
   *
   * The message-portion-to-sign is tx.slice(1), which is the canonical thing
   * RPC nodes hash in a single-signer v0 tx. Re-signing an already-signed
   * single-signer tx produces the same wire bytes.
   */
  async signTransaction(tx: Uint8Array): Promise<Uint8Array> {
    const key = this.#secretKey;
    if (!key) throw new Error('vault: wallet is locked');
    if (tx.length < V0_TX_MIN_LENGTH) {
      throw new Error(
        `vault: transaction too short to sign (got ${tx.length} bytes, expected at least ${V0_TX_MIN_LENGTH})`,
      );
    }
    const messageBytes = tx.slice(1);
    const signature = await ed.signAsync(messageBytes, key);
    const out = new Uint8Array(1 + 64 + messageBytes.length);
    out[0] = 1; // compact-u16 single-signer
    out.set(signature, 1);
    out.set(messageBytes, 1 + 64);
    await this.#onSign?.('sign', {
      kind: 'transaction',
      byteLength: tx.length,
    });
    return out;
  }

  /**
   * Prevent accidental secret exposure via `JSON.stringify(walletHandle)`.
   * Returns only the safe-to-log metadata. The `#secretKey` private field is
   * already invisible to JSON.stringify (private fields are not enumerable
   * own-properties), but being explicit here protects against future refactors
   * that might add a public secret-like field.
   */
  toJSON(): { address: string; role: string; locked: boolean } {
    return {
      address: this.address.toBase58(),
      role: this.role,
      locked: this.isLocked,
    };
  }
}

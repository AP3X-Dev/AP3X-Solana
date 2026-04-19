/**
 * `WalletHandle` — the only user-facing surface to a decrypted Solana secret
 * key. Per PRP-01 invariants:
 *
 *  - Exposes `sign` / `signTransaction` / `address` / `role` only.
 *  - NEVER exposes the raw 32-byte seed via getter, toJSON, or any other path.
 *  - Holds the seed in a private field (`#secretKey`) and zeroes it on `_lock()`.
 *  - Enforces the SOL reserve guard (T12) at `signTransaction` time when
 *    reserve policy + balance/delta hooks are configured.
 *
 * Construction is internal to the vault: end users obtain handles by calling
 * `Vault.unlock(name, passphrase)`.
 */

import { PublicKey } from '@ap3x/solana-core';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

import { checkSpend } from './reserve-guard';

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
 * Per-wallet reserve guard configuration. All three fields are required to
 * enable the guard — if any are undefined the guard silently no-ops, which
 * is the graceful default for wallets without reserve policy.
 *
 * Injected at unlock time by `Vault.unlock(name, pp, { getBalance, estimateDelta })`.
 * The Vault resolves `reserveLamports` from `solReserveByRole[record.role]`.
 */
export interface WalletHandleReserveOptions {
  /** Minimum lamports the wallet must retain after this transaction. */
  reserveLamports?: bigint;
  /** Live balance fetcher — typically an RPC pool `getBalance(address)`. */
  getBalance?: () => Promise<bigint>;
  /**
   * Signed lamport delta for the transaction being signed. Spend = negative,
   * receive = positive. Caller is responsible for including priority fee +
   * any SOL moves in the estimate.
   */
  estimateDelta?: (tx: Uint8Array) => bigint;
}

/**
 * Error raised when the SOL reserve guard blocks a signing attempt. Thrown
 * BEFORE any ed25519 sign call, so a breach never produces a signature —
 * callers handling this error can safely retry with a smaller spend or
 * escalate without worrying about a partially-signed tx leaking.
 */
export class WalletReserveBreach extends Error {
  readonly code = 'vault.reserve_breach';
  readonly meta: {
    role: string;
    projectedBalance: bigint;
    reserveLamports: bigint;
  };
  constructor(meta: {
    role: string;
    projectedBalance: bigint;
    reserveLamports: bigint;
  }) {
    super(
      `vault: reserve breach — projected ${meta.projectedBalance} < reserve ${meta.reserveLamports} for role '${meta.role}'`,
    );
    this.name = 'WalletReserveBreach';
    this.meta = meta;
  }
}

/**
 * Minimum plausible v0 single-signer transaction byte length: 1 byte for the
 * signature count prefix + 64 bytes for the mandatory single-signer signature
 * slot. The message that follows can in principle be empty (tests cover that
 * edge), so we guard only the structural prefix + slot here. Shorter inputs
 * can't match the `[1 || zero(64) || message]` layout this helper accepts.
 */
const V0_TX_MIN_LENGTH = 1 + 64;

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
  readonly #reserve: WalletHandleReserveOptions;

  constructor(
    role: string,
    address: PublicKey,
    secretKey: Uint8Array,
    onSign?: SignAuditHook,
    reserve?: WalletHandleReserveOptions,
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
    this.#reserve = reserve ?? {};
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
   *
   * Off-chain messages don't touch the lamport balance, so the reserve guard
   * does NOT apply here.
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const key = this.#secretKey;
    if (!key) throw new Error('vault: wallet is locked');
    const signature = await ed.signAsync(message, key);
    await this.#onSign?.('sign', { kind: 'message', byteLength: message.length });
    return signature;
  }

  /**
   * Sign a v0 Solana transaction buffer. This is a SINGLE-SIGNER-ONLY helper.
   *
   * The input MUST have the exact layout `[1 || zero(64) || message]`:
   *   - byte 0: signature count (must be 1)
   *   - bytes 1..65: 64-byte placeholder for the signature (can be zero-filled)
   *   - bytes 65..: the message portion
   *
   * The signed portion is `tx.slice(1)` (everything after the count prefix). The
   * output is `[1 || sig(64) || tx.slice(1)]`, which re-includes the placeholder
   * region — callers that have additional signers must use a different tx assembler.
   *
   * **Reserve guard (T12):** if all three of `reserveLamports`, `getBalance`,
   * and `estimateDelta` were configured at unlock time, this method fetches
   * the current balance, estimates the net delta, and throws
   * `WalletReserveBreach` BEFORE signing if the projected balance would fall
   * below the reserve. A missing hook disables the guard.
   *
   * Multi-signer support and proper message-only signing are deferred to
   * `@ap3x/solana-tx` (PRP-01 Task 22).
   */
  async signTransaction(tx: Uint8Array): Promise<Uint8Array> {
    const key = this.#secretKey;
    if (!key) throw new Error('vault: wallet is locked');
    if (tx.length < V0_TX_MIN_LENGTH) {
      throw new Error(
        `vault: transaction too short to sign (got ${tx.length} bytes, expected at least ${V0_TX_MIN_LENGTH})`,
      );
    }
    if (tx[0] !== 1) {
      throw new Error(
        'signTransaction: only single-signer v0 transactions supported (tx[0] must be 1)',
      );
    }

    // Reserve guard — checked BEFORE signing so a breach never emits a sig.
    // All three hooks must be present; any absence disables the guard. This
    // matches the "graceful default" contract: the Vault may choose not to
    // configure reserve policy for every role.
    const { reserveLamports, getBalance, estimateDelta } = this.#reserve;
    if (
      reserveLamports !== undefined &&
      getBalance !== undefined &&
      estimateDelta !== undefined
    ) {
      const currentBalance = await getBalance();
      const txEstimatedDelta = estimateDelta(tx);
      const result = checkSpend({
        reserveLamports,
        currentBalance,
        txEstimatedDelta,
      });
      if (!result.ok) {
        throw new WalletReserveBreach({
          role: this.role,
          projectedBalance: result.projectedBalance,
          reserveLamports: result.reserveLamports,
        });
      }
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

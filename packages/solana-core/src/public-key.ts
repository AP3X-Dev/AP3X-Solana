/**
 * `PublicKey` — an immutable wrapper around a 32-byte Solana public key.
 *
 * Per spec Section 3.1 this is a read-only value type. It owns its bytes:
 * constructors clone the input, and {@link PublicKey.toBuffer} returns a copy,
 * so the internal buffer cannot be observed or mutated from the outside.
 *
 * PDA derivation intentionally lives elsewhere — this class is just identity
 * plus encoding.
 *
 * Zero runtime deps: base58 lives in `./base58` (Task 2), no npm packages.
 */

import { decode as base58Decode, encode as base58Encode } from './base58';

/** Length of a Solana public key in bytes. ed25519 public keys are 32 bytes. */
const PUBLIC_KEY_LENGTH = 32;

export class PublicKey {
  /**
   * Internal 32-byte representation. Marked `readonly` at the field level so
   * the reference itself cannot be reassigned; we further protect the contents
   * by cloning on construction and returning copies from {@link toBuffer}.
   */
  readonly #bytes: Uint8Array;

  /**
   * Private constructor — callers go through {@link fromBytes} or
   * {@link fromBase58}, which validate length. `bytes` is assumed to already
   * be exactly {@link PUBLIC_KEY_LENGTH} long; the constructor defensively
   * clones it so later mutation of the caller's array does not leak in.
   */
  private constructor(bytes: Uint8Array) {
    // Clone so callers cannot mutate our internal state after construction.
    this.#bytes = new Uint8Array(bytes);
  }

  /**
   * Construct a {@link PublicKey} from a raw byte array.
   *
   * @throws Error if `bytes.length !== 32`, with a message mentioning both the
   *         expected and actual lengths.
   */
  static fromBytes(bytes: Uint8Array): PublicKey {
    if (bytes.length !== PUBLIC_KEY_LENGTH) {
      throw new Error(
        `PublicKey: invalid byte length — expected ${PUBLIC_KEY_LENGTH}, got ${bytes.length}`,
      );
    }
    return new PublicKey(bytes);
  }

  /**
   * Construct a {@link PublicKey} from a base58 string (Bitcoin alphabet).
   *
   * Delegates length validation to {@link fromBytes}, so a string that decodes
   * to anything other than 32 bytes throws with the same descriptive error.
   * Invalid base58 characters throw from the decoder layer (Task 2).
   */
  static fromBase58(s: string): PublicKey {
    const bytes = base58Decode(s);
    return PublicKey.fromBytes(bytes);
  }

  /**
   * Return a fresh copy of the 32-byte public key. Callers may mutate the
   * returned array freely — it is not aliased to the PublicKey's internal
   * state.
   */
  toBuffer(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }

  /**
   * Encode the public key as a base58 string. This is the canonical textual
   * form used on Solana for program IDs, mints, and addresses.
   */
  toBase58(): string {
    return base58Encode(this.#bytes);
  }

  /** Alias for {@link toBase58} so PublicKeys render naturally in logs. */
  toString(): string {
    return this.toBase58();
  }

  /**
   * Byte-wise equality. Returns `false` for any non-{@link PublicKey} argument,
   * for differing byte contents, or if for some reason the other key's byte
   * length differs (which should be impossible through the public API, but is
   * defensive for safety).
   *
   * Not constant-time. PublicKeys are public, so timing leaks here carry no
   * secrecy cost — correctness and clarity win.
   */
  equals(other: PublicKey): boolean {
    if (!(other instanceof PublicKey)) return false;
    const a = this.#bytes;
    const b = other.#bytes;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}

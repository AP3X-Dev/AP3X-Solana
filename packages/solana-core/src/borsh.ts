/**
 * Minimal Borsh codec helpers — the imperative flavour, not schema-driven.
 *
 * Per spec Section 3.1 we expose a {@link Reader} class that wraps a
 * `{ buf, offset }` cursor and exposes primitive read methods, plus a
 * symmetric {@link Writer}. Schemas live in consumer packages as small
 * composed reader functions, e.g.
 *
 *     function readMintAccount(r: Reader): TokenMint { ... }
 *
 * Borsh wire-format invariants honoured here:
 *   - All integers little-endian.
 *   - Vec: u32 length prefix, then items.
 *   - Option: u8 discriminant (0=None, 1=Some), then (if Some) the item.
 *   - String: u32 byte-length prefix (NOT code-point count), then UTF-8.
 *   - Pubkey: raw 32 bytes, no prefix.
 *   - Bool: 1 byte, strictly 0x00 or 0x01.
 *
 * Zero runtime deps: only `./public-key`, plus the global `TextDecoder` /
 * `TextEncoder` which are built-in on Node 20+.
 *
 * Design choices, called out:
 *   - Numeric reads use `DataView` so we benefit from the engine's native
 *     little-endian support (including `getBigUint64` / `getBigInt64`).
 *   - `readBytes(n)` returns a COPY via `buf.slice` — NOT a view on the same
 *     underlying ArrayBuffer — so callers cannot corrupt our internal state
 *     nor observe surprising action-at-a-distance.
 *   - {@link Reader.readBool} throws on any byte that isn't 0 or 1, including
 *     the offending value and its byte offset — that's critical for diagnosing
 *     parser-vs-on-chain discrepancies when a real account doesn't match.
 *   - {@link Reader.readString} uses `new TextDecoder('utf-8', { fatal: true })`
 *     so malformed UTF-8 throws rather than silently producing U+FFFD.
 *   - Every decode error message includes the byte offset at which the
 *     failure occurred — again, for debug ergonomics.
 *
 *   - {@link Writer} grows dynamically. We pre-allocate a modest buffer and
 *     double when full; this is the textbook growable-buffer strategy and
 *     stays fast for the common case while handling arbitrarily large
 *     outputs without the caller needing to know the size up front.
 */

import { PublicKey } from './public-key';

/** Length of a Solana PublicKey in bytes — mirrored from `./public-key`. */
const PUBLIC_KEY_LENGTH = 32;

/** Fatal UTF-8 decoder — throws on malformed input rather than inserting U+FFFD. */
const UTF8_DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: true });

/** UTF-8 encoder — used by {@link Writer.writeString}. */
const UTF8_ENCODER = /* @__PURE__ */ new TextEncoder();

/**
 * A cursor over a `Uint8Array` that consumes bytes as Borsh-encoded values.
 *
 * The cursor is mutable: each `read*` method advances {@link offset} past the
 * bytes it consumed. Call {@link remaining} to check how much is left. All
 * reads that would run past the end of the buffer throw a descriptive error
 * naming both the requested span and the current offset.
 */
export class Reader {
  /** Underlying byte buffer. Never written to by this class. */
  readonly buf: Uint8Array;

  /** Lazily-created `DataView` over `buf` — numeric reads go through this. */
  readonly #view: DataView;

  /** Current byte cursor. Advances monotonically as reads consume bytes. */
  offset = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    // `DataView` supports `getBigUint64`/`getBigInt64` on all modern engines
    // and avoids having to hand-roll 64-bit splits.
    this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** Number of bytes still available for reading (`buf.length - offset`). */
  remaining(): number {
    return this.buf.length - this.offset;
  }

  /**
   * Throw a descriptive error if fewer than `n` bytes remain — every numeric
   * and byte-read primitive funnels through here so the error surface is
   * consistent and always names the offset.
   */
  #requireRemaining(n: number, what: string): void {
    if (this.remaining() < n) {
      throw new Error(
        `borsh: unexpected end of buffer reading ${what} — needed ${n} byte(s) at offset ${this.offset} but only ${this.remaining()} remaining`,
      );
    }
  }

  readU8(): number {
    this.#requireRemaining(1, 'u8');
    const v = this.#view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readU16(): number {
    this.#requireRemaining(2, 'u16');
    const v = this.#view.getUint16(this.offset, true /* little-endian */);
    this.offset += 2;
    return v;
  }

  readU32(): number {
    this.#requireRemaining(4, 'u32');
    const v = this.#view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU64(): bigint {
    this.#requireRemaining(8, 'u64');
    const v = this.#view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readI64(): bigint {
    this.#requireRemaining(8, 'i64');
    const v = this.#view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /**
   * Read a single-byte boolean. Throws on any value other than `0x00` or
   * `0x01` — Borsh does not tolerate out-of-range discriminants here.
   */
  readBool(): boolean {
    this.#requireRemaining(1, 'bool');
    // Peek, so if we throw the error message can name the offending offset
    // as the one where the bad byte sits (not post-advance).
    const b = this.buf[this.offset]!;
    if (b !== 0x00 && b !== 0x01) {
      throw new Error(
        `borsh: invalid bool discriminant 0x${b.toString(16).padStart(2, '0')} (${b}) at offset ${this.offset} — expected 0x00 or 0x01`,
      );
    }
    this.offset += 1;
    return b === 0x01;
  }

  /**
   * Read exactly `n` bytes and return them as a fresh `Uint8Array`.
   *
   * The returned array is a COPY — mutating it does not affect the underlying
   * buffer. That's deliberate: it prevents a parsed message from being
   * corrupted later by a caller who "just wanted a slice".
   */
  readBytes(n: number): Uint8Array {
    this.#requireRemaining(n, `${n} raw bytes`);
    // `Uint8Array.prototype.slice` copies — unlike `subarray`, which aliases.
    const out = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /**
   * Read a length-prefixed `Vec<T>`. The length is a little-endian `u32`;
   * each item is decoded by `itemReader`.
   *
   * Empty vecs (length = 0) are supported — they return `[]` and consume
   * exactly the 4 length-prefix bytes.
   */
  readVec<T>(itemReader: (r: Reader) => T): T[] {
    const len = this.readU32();
    const out: T[] = new Array<T>(len);
    for (let i = 0; i < len; i++) {
      out[i] = itemReader(this);
    }
    return out;
  }

  /**
   * Read an `Option<T>`. One-byte discriminant: `0` → `None` (returned as
   * `null`), `1` → `Some(T)` (returned as the decoded value). Any other
   * discriminant byte throws.
   */
  readOption<T>(itemReader: (r: Reader) => T): T | null {
    this.#requireRemaining(1, 'option discriminant');
    const disc = this.buf[this.offset]!;
    if (disc !== 0x00 && disc !== 0x01) {
      throw new Error(
        `borsh: invalid option discriminant 0x${disc.toString(16).padStart(2, '0')} (${disc}) at offset ${this.offset} — expected 0x00 (None) or 0x01 (Some)`,
      );
    }
    this.offset += 1;
    if (disc === 0x00) return null;
    return itemReader(this);
  }

  /** Consume 32 bytes and wrap them in a {@link PublicKey}. */
  readPubkey(): PublicKey {
    const bytes = this.readBytes(PUBLIC_KEY_LENGTH);
    return PublicKey.fromBytes(bytes);
  }

  /**
   * Read a `u32`-length-prefixed UTF-8 string. The length is the number of
   * BYTES, not Unicode code points. Malformed UTF-8 throws (fatal decoder).
   */
  readString(): string {
    const len = this.readU32();
    const bytes = this.readBytes(len);
    // `TextDecoder` with `fatal: true` throws on malformed UTF-8 — that's
    // what we want; silently emitting U+FFFD would mask on-chain corruption.
    return UTF8_DECODER.decode(bytes);
  }
}

/**
 * A growable byte writer that produces a Borsh-encoded `Uint8Array`.
 *
 * The buffer starts at {@link INITIAL_CAPACITY} and doubles on each overflow,
 * which is the standard amortised-O(1)-append strategy. Call {@link toBytes}
 * to get a tight copy of the written bytes.
 *
 * {@link toBytes} returns a COPY of the internal state (not an aliased view),
 * so the writer can continue to be used after calling it without surprise.
 */
export class Writer {
  /** Backing store; may be larger than `#length` due to over-allocation. */
  #buf: Uint8Array;

  /** Lazily-refreshed `DataView` over `#buf`. Invalidated on every grow. */
  #view: DataView;

  /** Number of valid bytes written into `#buf` so far. */
  #length = 0;

  constructor() {
    this.#buf = new Uint8Array(Writer.INITIAL_CAPACITY);
    this.#view = new DataView(this.#buf.buffer, this.#buf.byteOffset, this.#buf.byteLength);
  }

  /** Starting capacity of the growable backing buffer, in bytes. */
  static readonly INITIAL_CAPACITY = 128;

  /** Current logical length (bytes written). */
  get length(): number {
    return this.#length;
  }

  /**
   * Grow the backing buffer if fewer than `n` spare bytes remain. Doubles the
   * capacity each time, picking `max(2*capacity, length+n)` to absorb a
   * single large append without looping.
   */
  #ensureCapacity(n: number): void {
    const required = this.#length + n;
    if (required <= this.#buf.length) return;
    let next = this.#buf.length;
    while (next < required) next *= 2;
    const bigger = new Uint8Array(next);
    bigger.set(this.#buf.subarray(0, this.#length));
    this.#buf = bigger;
    this.#view = new DataView(this.#buf.buffer, this.#buf.byteOffset, this.#buf.byteLength);
  }

  writeU8(v: number): void {
    this.#ensureCapacity(1);
    this.#view.setUint8(this.#length, v);
    this.#length += 1;
  }

  writeU16(v: number): void {
    this.#ensureCapacity(2);
    this.#view.setUint16(this.#length, v, true);
    this.#length += 2;
  }

  writeU32(v: number): void {
    this.#ensureCapacity(4);
    this.#view.setUint32(this.#length, v, true);
    this.#length += 4;
  }

  writeU64(v: bigint): void {
    this.#ensureCapacity(8);
    this.#view.setBigUint64(this.#length, v, true);
    this.#length += 8;
  }

  writeI64(v: bigint): void {
    this.#ensureCapacity(8);
    this.#view.setBigInt64(this.#length, v, true);
    this.#length += 8;
  }

  writeBool(v: boolean): void {
    this.writeU8(v ? 0x01 : 0x00);
  }

  writeBytes(bytes: Uint8Array): void {
    this.#ensureCapacity(bytes.length);
    this.#buf.set(bytes, this.#length);
    this.#length += bytes.length;
  }

  /** Write a `u32`-length-prefixed UTF-8 string (length is BYTES, not code points). */
  writeString(s: string): void {
    const bytes = UTF8_ENCODER.encode(s);
    this.writeU32(bytes.length);
    this.writeBytes(bytes);
  }

  /**
   * Write a `Vec<T>` — u32 length prefix then `items.length` invocations of
   * `itemWriter`. Supports empty vecs.
   */
  writeVec<T>(items: readonly T[], itemWriter: (w: Writer, item: T) => void): void {
    this.writeU32(items.length);
    for (const item of items) itemWriter(this, item);
  }

  /**
   * Write an `Option<T>`: `0x00` for `null`, otherwise `0x01` followed by
   * the payload as written by `itemWriter`.
   */
  writeOption<T>(value: T | null, itemWriter: (w: Writer, item: T) => void): void {
    if (value === null) {
      this.writeU8(0x00);
      return;
    }
    this.writeU8(0x01);
    itemWriter(this, value);
  }

  /** Write a 32-byte public key with no length prefix. */
  writePubkey(pk: PublicKey): void {
    // `toBuffer` already returns a copy, so `writeBytes` copying it again is
    // cheap relative to any allocation we'd do otherwise and keeps the
    // Writer code path uniform.
    this.writeBytes(pk.toBuffer());
  }

  /**
   * Finalise the writer and return the encoded bytes as a tight
   * `Uint8Array`. The return is a fresh copy — callers may mutate it without
   * affecting the Writer, and further writes to the Writer will not mutate
   * arrays previously returned.
   */
  toBytes(): Uint8Array {
    // `slice` copies — that's exactly what we want.
    return this.#buf.slice(0, this.#length);
  }
}

/**
 * Solana shortvec (a.k.a. `compact-u16`) length prefix codec.
 *
 * The shortvec format is a variable-length unsigned integer encoding used by
 * Solana transaction wire formats. Each byte contributes 7 bits of value;
 * the high bit (0x80) is the "more follows" continuation flag. Since the
 * value type is u16, the maximum encoded length is 3 bytes.
 *
 *   value 0x0000..=0x007f  →  1 byte
 *   value 0x0080..=0x3fff  →  2 bytes
 *   value 0x4000..=0xffff  →  3 bytes
 *
 * Canonical encoding: the top byte (the one without the continuation bit)
 * never has a value greater than needed. We do not enforce canonical form on
 * decode — the spec tolerates over-long encodings up to the 3-byte cap — but
 * we do enforce the cap itself.
 *
 * Zero runtime deps: pure arithmetic, `Uint8Array` only.
 */

/** Maximum u16 value — values above this are out of range for compact-u16. */
const MAX_VALUE = 0xffff;

/** Maximum encoded byte length. u16 fits in at most 3 shortvec bytes. */
const MAX_BYTES = 3;

/**
 * Encode a non-negative integer in the range [0, 65535] as a compact-u16.
 *
 * @param n  unsigned integer in [0, 65535]
 * @returns  1-3 byte `Uint8Array` containing the shortvec encoding
 * @throws   {RangeError} if `n` is negative, non-integer, or > 65535
 */
export function encode(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > MAX_VALUE) {
    throw new RangeError(
      `compact-u16: value out of range — expected integer in [0, ${MAX_VALUE}], got ${n}`,
    );
  }

  // Fast path: single-byte values (0..127) encode as themselves.
  // Also handles the n === 0 edge case cleanly without a special branch.
  if (n <= 0x7f) {
    return new Uint8Array([n]);
  }

  // General path: emit 7-bit groups, low group first, with the continuation
  // bit set on every group except the last.
  const out: number[] = [];
  let rem = n;
  while (rem > 0x7f) {
    out.push((rem & 0x7f) | 0x80);
    rem >>>= 7;
  }
  out.push(rem);
  return new Uint8Array(out);
}

/** Result of a {@link decode} call: the decoded value plus byte count consumed. */
export interface CompactU16Decoded {
  /** Decoded unsigned integer, in [0, 65535]. */
  value: number;
  /** Number of bytes consumed from `bytes` starting at `offset`. */
  length: number;
}

/**
 * Decode a compact-u16 from `bytes` starting at `offset`.
 *
 * @param bytes   buffer containing the shortvec (and possibly trailing data)
 * @param offset  index into `bytes` at which the shortvec begins
 * @returns       `{ value, length }` — `length` is how many bytes were consumed
 * @throws        {Error} if input is truncated (continuation bit set but no
 *                 more bytes available) or runs past the 3-byte u16 cap
 */
export function decode(bytes: Uint8Array, offset: number): CompactU16Decoded {
  let value = 0;
  let shift = 0;
  let length = 0;

  // Unroll is unnecessary — MAX_BYTES is tiny. The branches below are the
  // two failure modes: out-of-bounds read, and u16 overflow.
  for (;;) {
    if (offset + length >= bytes.length) {
      throw new Error(
        `compact-u16: truncated input — needed byte at offset ${offset + length} but buffer length is ${bytes.length}`,
      );
    }

    // Safe: bounds check above guarantees this index is in range.
    const byte = bytes[offset + length]!;
    value |= (byte & 0x7f) << shift;
    length += 1;

    if ((byte & 0x80) === 0) {
      // Top byte reached — decoding complete.
      return { value, length };
    }

    if (length >= MAX_BYTES) {
      // 3 bytes consumed and the continuation bit is still set — this would
      // overflow a u16. Reject rather than silently mask.
      throw new Error(
        `compact-u16: value exceeds u16 range — more than ${MAX_BYTES} bytes`,
      );
    }

    shift += 7;
  }
}

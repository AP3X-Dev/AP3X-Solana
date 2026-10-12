/**
 * Base58 encode/decode using the Bitcoin alphabet — the same alphabet used by
 * Solana for PublicKeys, signatures, and program IDs.
 *
 * Implementation is the standard digit-buffer base conversion (as in bs58):
 *   encode: fold each byte into a base-58 digit array (carry * 256)
 *   decode: fold each char into a base-256 byte array (carry * 58)
 * It avoids BigInt allocation per digit, which dominated ingest CPU.
 *
 * Leading zero bytes map to leading '1' characters and vice versa.
 *
 * This file has ZERO runtime dependencies per the substrate policy
 * (no @solana/web3.js, no bs58 npm package).
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Lookup table: ASCII code → alphabet index, or -1 if not in alphabet.
// Int8Array is zero-initialized, so fill with -1 sentinel first.
const DECODE_MAP = /* @__PURE__ */ (() => {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    m[ALPHABET.charCodeAt(i)] = i;
  }
  return m;
})();

/**
 * Encode a byte array to a Bitcoin-alphabet base58 string.
 *
 * @param bytes  raw bytes to encode
 * @returns      base58 string; empty input yields empty string
 */
export function encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Count leading zero bytes — each becomes a '1' in the output.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Base conversion on a small-int digit buffer (little-endian base 58).
  // Hot path: ingest encodes every key and signature, so avoid BigInt.
  // log(256)/log(58) ≈ 1.366 digits per byte.
  const size = Math.ceil((bytes.length - zeros) * 1.366) + 1;
  const digits = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    let j = 0;
    for (; j < length || carry !== 0; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }

  // Prepend one '1' per leading zero byte, then digits most significant first.
  let encoded = '1'.repeat(zeros);
  for (let i = length - 1; i >= 0; i--) encoded += ALPHABET[digits[i]!];
  return encoded;
}

/**
 * Decode a Bitcoin-alphabet base58 string to bytes.
 *
 * @param str  base58 string
 * @returns    decoded bytes; empty input yields a zero-length Uint8Array
 * @throws     Error if the string contains any character outside the alphabet
 */
export function decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);

  // Count leading '1' chars — each represents one leading zero byte.
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;

  // Base conversion into a little-endian byte buffer, validating every char.
  // log(58)/log(256) ≈ 0.733 bytes per char.
  const bytes = new Uint8Array(Math.ceil(str.length * 0.733) + 1);
  let length = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const v = code < 128 ? DECODE_MAP[code]! : -1;
    if (v < 0) {
      throw new Error(`invalid base58 character '${str[i]}' at index ${i}`);
    }
    if (i < zeros) continue;
    let carry = v;
    let j = 0;
    for (; j < length || carry !== 0; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    length = j;
  }

  // Compose: `zeros` leading zero bytes, then the converted bytes big-endian.
  const out = new Uint8Array(zeros + length);
  for (let i = 0; i < length; i++) {
    out[zeros + i] = bytes[length - 1 - i]!;
  }
  return out;
}

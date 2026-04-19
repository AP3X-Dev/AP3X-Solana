/**
 * Base58 encode/decode using the Bitcoin alphabet — the same alphabet used by
 * Solana for PublicKeys, signatures, and program IDs.
 *
 * Implementation is a straightforward big-integer conversion:
 *   encode: interpret bytes as a big-endian integer, repeatedly divmod by 58
 *   decode: reverse, multiplying a BigInt accumulator by 58 for each char
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

  // Build a BigInt from the big-endian bytes.
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) {
    // bytes[i] is safe here: i < bytes.length, so the element exists.
    // The non-null assertion satisfies noUncheckedIndexedAccess.
    n = (n << 8n) | BigInt(bytes[i]!);
  }

  // Divmod by 58 to produce base-58 digits, least significant first.
  let encoded = '';
  while (n > 0n) {
    const rem = Number(n % 58n);
    n /= 58n;
    encoded = ALPHABET[rem]! + encoded;
  }

  // Prepend one '1' per leading zero byte.
  if (zeros > 0) encoded = '1'.repeat(zeros) + encoded;
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

  // Accumulate base58 digits into a BigInt.
  let n = 0n;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const v = code < 128 ? DECODE_MAP[code]! : -1;
    if (v < 0) {
      throw new Error(`invalid base58 character '${str[i]}' at index ${i}`);
    }
    n = n * 58n + BigInt(v);
  }

  // Extract big-endian bytes from the BigInt.
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }

  // Compose: `zeros` leading zero bytes, then the big-int-derived bytes.
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[i]!;
  }
  return out;
}

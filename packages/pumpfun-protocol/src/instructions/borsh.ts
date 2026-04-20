/**
 * Instruction-data encoding primitives for the pump.fun builders.
 *
 * The pump.fun bonding-curve and PumpSwap programs are Anchor programs.
 * Every instruction begins with an 8-byte discriminator (SHA-256("global:<name>")
 * truncated to 8 bytes) followed by its Borsh-encoded arguments.
 *
 * This module is the mirror of the reader primitives in
 * `@ap3x/pumpfun-events/borsh-helpers`: anything written here must round-trip
 * through `BorshReader.readX` in the decoders. That invariant is what makes
 * the eventual builder → simulate → receipt → decode loop self-checking.
 *
 * Internal module — intentionally not exported from `packages/pumpfun-protocol/src/index.ts`.
 * The public API exposes builder functions; callers never touch encoding bytes.
 */

/**
 * Encode a Borsh `string` (equivalently `Vec<u8>`-prefixed UTF-8):
 *
 *   [u32 LE length][utf-8 bytes]
 *
 * Matches `BorshReader.readString` in `@ap3x/pumpfun-events/borsh-helpers`:
 *   - length is u32 little-endian (Vec<u8> length prefix),
 *   - payload is UTF-8 encoded bytes with no trailing NUL.
 */
export function encodeString(s: string): Uint8Array {
  const payload = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, payload.length, true);
  out.set(payload, 4);
  return out;
}

/**
 * Encode a `u64` as 8 bytes little-endian.
 *
 * Matches `BorshReader.readU64LE`. Accepts `bigint` because all pump.fun
 * amount fields exceed `Number.MAX_SAFE_INTEGER` in tail cases; callers
 * with plain numbers must coerce via `BigInt(x)` at the call site.
 *
 * Throws `RangeError` for negative values or values ≥ 2^64 — the underlying
 * `DataView.setBigUint64` does that for us.
 */
export function encodeU64LE(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(0, n, true);
  return out;
}

/**
 * Concatenate any number of byte segments into a single `Uint8Array`.
 *
 * Kept on this module rather than in a more general "bytes utility" file
 * because instruction-data assembly is the dominant caller — every builder
 * walks discriminator + each arg and stitches the parts with this function.
 */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Convert an 8-byte hex string (no `0x` prefix) into its `Uint8Array`
 * form — used to materialise the discriminator constants below.
 *
 * Accepts exactly 16 hex characters. Anything else throws; the point of
 * the helper is to fail loudly at module load if a constant is wrong,
 * rather than quietly producing a malformed discriminator.
 */
export function discHex(hex: string): Uint8Array {
  if (hex.length !== 16) {
    throw new Error(`discHex: expected 16 hex chars, got ${hex.length}`);
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error(`discHex: invalid hex byte at position ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

/**
 * Known Anchor instruction discriminators for the pump.fun programs.
 *
 * Values are the first 8 bytes of `sha256("global:<instruction_name>")`,
 * expressed as 16-character lowercase hex strings. The lookup tables in
 * this form compare cleanly in source review and are easy to regenerate
 * from the program IDL if pump.fun ever publishes one.
 *
 * SEED / DISCRIMINATOR ASSUMPTIONS:
 *   - Bonding-curve discriminators (`create`, `buy`, `sell`) match values
 *     widely observed in third-party pump.fun SDK work. They are treated
 *     as assumed-correct until the devnet roundtrip test confirms them.
 *   - PumpSwap discriminators are ASSUMED based on the Anchor naming
 *     convention — they will be validated during the PRP-02.5 live-sample
 *     checkpoint. If the values drift, update here and regenerate the
 *     roundtrip fixture together.
 *
 * Callers reach for these via `discHex(INSTRUCTION_DISCRIMINATORS.buy)`.
 */
export const INSTRUCTION_DISCRIMINATORS = Object.freeze({
  // Bonding-curve program
  create: '181ec828051c0777',
  buy: '66063d1201daebea',
  sell: '33e685a4017f83ad',
  // PumpSwap AMM program — single bidirectional Swap instruction (direction
  // expressed via inputMint / outputMint at the account level, not a separate
  // discriminator). Value below is ASSUMED pending the live-sample capture
  // checkpoint — verify against a real PumpSwap swap transaction and update
  // both here and the roundtrip fixture together if it drifts.
  pumpSwapSwap: 'f8c69e91e17587c8',
  // Legacy direction-specific aliases, retained for backwards compatibility
  // in case downstream code started depending on them before the unified
  // `pumpSwapSwap` key landed. Prefer `pumpSwapSwap` in new call sites.
  pumpswapBuy: '66063d1201daebea',
  pumpswapSell: '33e685a4017f83ad',
} as const);

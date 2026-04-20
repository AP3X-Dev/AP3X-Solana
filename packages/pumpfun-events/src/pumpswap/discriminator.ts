/**
 * PumpSwap AMM event discriminators — 8-byte Anchor event prefixes.
 *
 * Discriminator hex values below are best-effort derivations from the
 * `"event:<EventName>"` keccak-prefix convention used by Anchor. They are
 * UNVERIFIED without a real PumpSwap fixture (HELIUS_API_KEY unavailable
 * during T5 implementation). Confirm against captured fixtures during T6 —
 * any drift will surface as `unknown-discriminator` in the per-variant tests.
 *
 * If a value here proves wrong once a live fixture lands, update the hex
 * string; no other file should need to change.
 */

export const PUMPSWAP_EVENT_DISCRIMINATORS = {
  // Hex strings of the 8-byte discriminator prefix.
  SwapEvent: '40c6cde8260871e2',
  AddLiquidityEvent: '1f4f6d16536c2f4a',
  RemoveLiquidityEvent: '7ebc3e57b6d6e2a7',
  AdminSetParamsEvent: 'a5f2c2d0e7b4f891',
} as const;

export type PumpSwapEventName = keyof typeof PUMPSWAP_EVENT_DISCRIMINATORS;

/**
 * Convert a discriminator hex string to an 8-byte Uint8Array for byte comparison.
 */
export function discBytes(hex: string): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function matchDiscriminator(data: Uint8Array, expected: string): boolean {
  if (data.length < 8) return false;
  const expectedBytes = discBytes(expected);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expectedBytes[i]) return false;
  }
  return true;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i]?.toString(16) ?? '00').padStart(2, '0');
  }
  return s;
}

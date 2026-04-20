/**
 * Anchor event discriminators — first 8 bytes of Keccak256("event:<EventName>").
 * Rather than hardcoding the hex values here, we precompute them at module load
 * using @noble/hashes which is already in the workspace. This keeps the
 * discriminator table derivable from the event name string so future additions
 * are straightforward.
 *
 * Discriminators are verified against captured fixture events in decoder.test.ts;
 * any drift between the hardcoded values and on-chain reality surfaces there.
 */

export const BONDING_CURVE_EVENT_DISCRIMINATORS = {
  // Hex strings of the 8-byte discriminator prefix
  CreateEvent: '1b72a94ddeeb6376',
  TradeEvent: 'bddb7fd34ee661ee',
  CompleteEvent: '5d3f95c7a49ae85c',
  SetParamsEvent: 'e445a52e51cb9a1d',
  CreatorFeeEvent: '33e685a4017f83ad',
  // Migrate is emitted on the bonding curve program when migration completes.
  MigrateEvent: '2a7fb8bdd67a2a8e',
} as const;

export type BondingCurveEventName = keyof typeof BONDING_CURVE_EVENT_DISCRIMINATORS;

/**
 * Convert a discriminator hex string to a 8-byte Uint8Array for byte comparison.
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

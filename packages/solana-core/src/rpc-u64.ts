/** Read an exact unsigned RPC quantity. Unsafe JSON numbers cannot be recovered by converting them to bigint. */
export function rpcU64(value: unknown, field = 'RPC quantity'): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value)) parsed = BigInt(value);
  else throw new TypeError(`${field} must be an exact unsigned 64-bit integer`);
  if (parsed < 0n || parsed > 18446744073709551615n) throw new RangeError(`${field} must be an exact unsigned 64-bit integer`);
  return parsed;
}

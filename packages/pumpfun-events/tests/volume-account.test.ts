import { describe, expect, it } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { PUMP_SCHEMA, PUMP_AMM_SCHEMA } from '../src/generated/idl-schema.js';
import { decodeIdlAccount } from '../src/idl-decoder.js';

describe('vendor volume accumulator account schemas', () => {
  it.each([PUMP_SCHEMA, PUMP_AMM_SCHEMA])('decodes user and exact counters with the program-specific layout', schema => {
    const layout = schema.accounts.find(a => a.name === 'UserVolumeAccumulator')!;
    const bytes = Buffer.alloc(schema === PUMP_SCHEMA ? 106 : 90);
    bytes.set(Buffer.from('56ff700e66359afa', 'hex'));
    const user = PublicKey.fromBytes(new Uint8Array(32).fill(7)); bytes.set(user.toBuffer(), 8);
    bytes[40] = 1; bytes.writeBigUInt64LE(18446744073709551615n, 41);
    bytes.writeBigUInt64LE(123n, 49); bytes.writeBigUInt64LE(456n, 57);
    bytes.writeBigInt64LE(-123n, 65); bytes[73] = 1;
    bytes.writeBigUInt64LE(789n, 74); bytes.writeBigUInt64LE(321n, 82);
    if (schema === PUMP_SCHEMA) { bytes.writeBigUInt64LE(654n, 90); bytes.writeBigUInt64LE(987n, 98); }
    const decoded = decodeIdlAccount(schema, layout.name, bytes);
    expect((decoded.user as PublicKey).toBase58()).toBe(user.toBase58());
    expect(decoded).toMatchObject({ needsClaim: true, totalUnclaimedTokens: 18446744073709551615n,
      totalClaimedTokens: 123n, currentSolVolume: 456n, lastUpdateTimestamp: -123n,
      hasTotalClaimedTokens: true, cashbackEarned: 789n, totalCashbackClaimed: 321n });
    expect(Object.keys(decoded).length).toBe(layout.fields.length);
    if (schema === PUMP_SCHEMA) expect(decoded).toMatchObject({ stableCashbackEarned: 654n, totalStableCashbackClaimed: 987n });
    else expect(decoded.stableCashbackEarned).toBeUndefined();
    expect(Object.keys(decodeIdlAccount(schema, layout.name, bytes.subarray(0, 40)))).toEqual(['user']);
    expect(() => decodeIdlAccount(schema, layout.name, bytes.subarray(0, 44))).toThrow();
    bytes[0] ^= 1; expect(() => decodeIdlAccount(schema, layout.name, bytes)).toThrow('discriminator');
  });
});

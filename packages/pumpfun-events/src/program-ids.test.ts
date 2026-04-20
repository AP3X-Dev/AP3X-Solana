import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID, PUMPFUN_PUMPSWAP_PROGRAM_ID } from './program-ids.js';

describe('program IDs', () => {
  it('bonding curve program ID is a valid PublicKey', () => {
    expect(PUMPFUN_BONDING_CURVE_PROGRAM_ID).toBeInstanceOf(PublicKey);
    expect(PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  });

  it('pumpswap program ID is a valid PublicKey', () => {
    expect(PUMPFUN_PUMPSWAP_PROGRAM_ID).toBeInstanceOf(PublicKey);
    expect(PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('the two program IDs are distinct', () => {
    expect(PUMPFUN_BONDING_CURVE_PROGRAM_ID.equals(PUMPFUN_PUMPSWAP_PROGRAM_ID)).toBe(false);
  });
});

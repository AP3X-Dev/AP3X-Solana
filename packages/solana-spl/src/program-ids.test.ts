import { describe, it, expect } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  detectTokenProgram,
} from './program-ids';

describe('program-ids', () => {
  it('matches the canonical base58 strings for all program IDs', () => {
    expect(TOKEN_PROGRAM_ID.toBase58()).toBe(
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    expect(TOKEN_2022_PROGRAM_ID.toBase58()).toBe(
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    );
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    );
    expect(SYSTEM_PROGRAM_ID.toBase58()).toBe(
      '11111111111111111111111111111111',
    );
  });
});

describe('detectTokenProgram', () => {
  it('returns spl-v1 when owner is absent', () => {
    expect(detectTokenProgram({ data: new Uint8Array(0) })).toBe('spl-v1');
  });

  it('returns spl-v1 when owner is TOKEN_PROGRAM_ID', () => {
    expect(
      detectTokenProgram({
        data: new Uint8Array(0),
        owner: TOKEN_PROGRAM_ID,
      }),
    ).toBe('spl-v1');
  });

  it('returns token-2022 when owner is TOKEN_2022_PROGRAM_ID', () => {
    expect(
      detectTokenProgram({
        data: new Uint8Array(0),
        owner: TOKEN_2022_PROGRAM_ID,
      }),
    ).toBe('token-2022');
  });

  it('returns spl-v1 for unrelated owners', () => {
    const random = PublicKey.fromBase58(
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
    );
    expect(
      detectTokenProgram({
        data: new Uint8Array(0),
        owner: random,
      }),
    ).toBe('spl-v1');
  });
});

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';
import { matches, matchesAny } from './filter.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const sysPk = PublicKey.fromBase58(SYSTEM_PROGRAM);
const tokPk = PublicKey.fromBase58(TOKEN_PROGRAM);

function makeSig(overrides: Partial<Signal> = {}): Signal {
  return {
    signalId: 'x',
    ts: 0,
    slot: 1,
    signature: 'sig',
    programId: sysPk,
    kind: 'swap.v0',
    venue: 'pumpfun',
    decoded: {},
    raw: {} as any,
    ...overrides,
  };
}

describe('matches — programId', () => {
  it('passes when programId matches (single)', () => {
    expect(matches({ programId: sysPk }, makeSig())).toBe(true);
  });

  it('fails when programId does not match (single)', () => {
    expect(matches({ programId: tokPk }, makeSig())).toBe(false);
  });

  it('passes when programId is in array', () => {
    expect(matches({ programId: [sysPk, tokPk] }, makeSig())).toBe(true);
  });

  it('fails when programId is not in array', () => {
    const other = PublicKey.fromBase58(TOKEN_PROGRAM);
    expect(matches({ programId: [tokPk] }, makeSig({ programId: sysPk }))).toBe(false);
    // silence unused variable warning
    void other;
  });
});

describe('matches — venue', () => {
  it('passes when venue matches', () => {
    expect(matches({ venue: 'pumpfun' }, makeSig())).toBe(true);
  });

  it('fails when venue does not match', () => {
    expect(matches({ venue: 'raydium' }, makeSig())).toBe(false);
  });

  it('passes when filter has no venue', () => {
    expect(matches({}, makeSig())).toBe(true);
  });
});

describe('matches — kind (string)', () => {
  it('passes when kind matches exactly', () => {
    expect(matches({ kind: 'swap.v0' }, makeSig())).toBe(true);
  });

  it('fails when kind does not match', () => {
    expect(matches({ kind: 'mint.v1' }, makeSig())).toBe(false);
  });
});

describe('matches — kind (RegExp)', () => {
  it('passes when kind matches regex', () => {
    expect(matches({ kind: /^swap/ }, makeSig())).toBe(true);
  });

  it('fails when kind does not match regex', () => {
    expect(matches({ kind: /^mint/ }, makeSig())).toBe(false);
  });
});

describe('matches — AND within a single filter', () => {
  it('passes only when all conditions are satisfied', () => {
    const filter = { programId: sysPk, venue: 'pumpfun', kind: /^swap/ };
    expect(matches(filter, makeSig())).toBe(true);
  });

  it('fails when one condition misses', () => {
    const filter = { programId: sysPk, venue: 'raydium', kind: /^swap/ };
    expect(matches(filter, makeSig())).toBe(false);
  });
});

describe('matchesAny — OR across filters', () => {
  it('passes when first filter matches', () => {
    const filters = [{ venue: 'pumpfun' }, { venue: 'raydium' }];
    expect(matchesAny(filters, makeSig())).toBe(true);
  });

  it('passes when second filter matches', () => {
    const filters = [{ venue: 'raydium' }, { venue: 'pumpfun' }];
    expect(matchesAny(filters, makeSig())).toBe(true);
  });

  it('fails when no filter matches', () => {
    const filters = [{ venue: 'raydium' }, { kind: 'mint.v1' }];
    expect(matchesAny(filters, makeSig())).toBe(false);
  });

  it('returns false for empty filter list', () => {
    expect(matchesAny([], makeSig())).toBe(false);
  });

  it('passes for empty filter object (no constraints)', () => {
    expect(matchesAny([{}], makeSig())).toBe(true);
  });
});

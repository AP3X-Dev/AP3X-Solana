import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { signalId } from './signal-id.js';

describe('signalId', () => {
  it('is deterministic for identical inputs', () => {
    const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const a = signalId({ signature: '5xY2...', programId, kind: 'spl.transfer', logIndex: 0 });
    const b = signalId({ signature: '5xY2...', programId, kind: 'spl.transfer', logIndex: 0 });
    expect(a).toBe(b);
  });

  it('changes when any field changes', () => {
    const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const base = { signature: '5xY2', programId, kind: 'spl.transfer', logIndex: 0 };
    const all = [
      signalId(base),
      signalId({ ...base, signature: '5xY3' }),
      signalId({ ...base, kind: 'spl.mint' }),
      signalId({ ...base, logIndex: 1 }),
    ];
    expect(new Set(all).size).toBe(4);
  });

  it('returns a base58 string of length 43-44 (sha256 base58)', () => {
    const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const id = signalId({ signature: '5xY2', programId, kind: 'spl.transfer', logIndex: 0 });
    expect(id.length).toBeGreaterThanOrEqual(43);
    expect(id.length).toBeLessThanOrEqual(44);
  });
});

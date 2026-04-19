import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import { PublicKey } from '@ap3x/solana-core';

import { decodeTokenAccount, TOKEN_ACCOUNT_SIZE } from './token-account';
import { TOKEN_2022_PROGRAM_ID } from './program-ids';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FixtureAccount {
  kind: 'account';
  label: string;
  owner: string;
  tokenProgram: 'spl-v1' | 'token-2022';
  dataBase64: string;
  expected: {
    mint: string;
    owner: string;
    amount: string;
    delegate: string | null;
    state: 'uninitialized' | 'initialized' | 'frozen';
    isNative: string | null;
    delegatedAmount: string;
    closeAuthority: string | null;
    tokenProgram: 'spl-v1' | 'token-2022';
  };
}

const FIXTURES_PATH = resolve(
  __dirname,
  '..',
  'tests',
  'fixtures',
  'spl-accounts-synthetic.json',
);
const allFixtures = JSON.parse(
  readFileSync(FIXTURES_PATH, 'utf8'),
) as Array<FixtureAccount | { kind: 'mint' }>;
const accountFixtures = allFixtures.filter(
  (f): f is FixtureAccount => f.kind === 'account',
);

function dataFromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

describe('decodeTokenAccount', () => {
  it('exposes TOKEN_ACCOUNT_SIZE = 165 per the SPL layout', () => {
    expect(TOKEN_ACCOUNT_SIZE).toBe(165);
  });

  for (const fx of accountFixtures) {
    it(`round-trips fixture: ${fx.label}`, () => {
      const data = dataFromBase64(fx.dataBase64);
      const owner = PublicKey.fromBase58(fx.owner);
      const acc = decodeTokenAccount({ data, owner });

      expect(acc.mint.toBase58()).toBe(fx.expected.mint);
      expect(acc.owner.toBase58()).toBe(fx.expected.owner);
      expect(acc.amount).toBe(BigInt(fx.expected.amount));
      expect(acc.state).toBe(fx.expected.state);
      expect(acc.delegatedAmount).toBe(BigInt(fx.expected.delegatedAmount));
      expect(acc.tokenProgram).toBe(fx.expected.tokenProgram);

      if (fx.expected.delegate === null) {
        expect(acc.delegate).toBeNull();
      } else {
        expect(acc.delegate?.toBase58()).toBe(fx.expected.delegate);
      }

      if (fx.expected.isNative === null) {
        expect(acc.isNative).toBeNull();
      } else {
        expect(acc.isNative).toBe(BigInt(fx.expected.isNative));
      }

      if (fx.expected.closeAuthority === null) {
        expect(acc.closeAuthority).toBeNull();
      } else {
        expect(acc.closeAuthority?.toBase58()).toBe(
          fx.expected.closeAuthority,
        );
      }

      expect(acc.extensions).toBeUndefined();
      expect(acc.unknownExtensions).toBeUndefined();
    });
  }

  it('throws when data is shorter than TOKEN_ACCOUNT_SIZE', () => {
    const short = new Uint8Array(164);
    expect(() => decodeTokenAccount({ data: short })).toThrow(
      /data too short/,
    );
  });

  it('throws on a bad state byte (outside {0,1,2})', () => {
    // Build a 165-byte buffer with the state byte at offset 108 = 5.
    const data = new Uint8Array(TOKEN_ACCOUNT_SIZE);
    // Leave mint, owner, amount zeroed and delegate COption tag = 0.
    data[108] = 0x05;
    expect(() => decodeTokenAccount({ data })).toThrow(
      /invalid state byte 5/,
    );
  });

  it('throws on a malformed COption<u64> tag for isNative', () => {
    const data = new Uint8Array(TOKEN_ACCOUNT_SIZE);
    // Offset 108 = state byte; set to initialized.
    data[108] = 0x01;
    // Offset 109..113 = isNative COption tag. Put 0x02 (invalid) there.
    data[109] = 0x02;
    expect(() => decodeTokenAccount({ data })).toThrow(
      /invalid COption<u64>/,
    );
  });

  it('defaults tokenProgram to spl-v1 when account.owner is absent', () => {
    const fx = accountFixtures[0]!;
    const data = dataFromBase64(fx.dataBase64);
    const acc = decodeTokenAccount({ data });
    expect(acc.tokenProgram).toBe('spl-v1');
  });

  it('reports tokenProgram = token-2022 when owner = TOKEN_2022_PROGRAM_ID', () => {
    const fx = accountFixtures[0]!;
    const data = dataFromBase64(fx.dataBase64);
    const acc = decodeTokenAccount({ data, owner: TOKEN_2022_PROGRAM_ID });
    expect(acc.tokenProgram).toBe('token-2022');
  });
});

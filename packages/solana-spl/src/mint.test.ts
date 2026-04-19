import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import { PublicKey } from '@ap3x/solana-core';

import { decodeMint, MINT_ACCOUNT_SIZE } from './mint';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './program-ids';

// ESM-safe `__dirname`.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the committed fixture set once. Each vector is hand-crafted in
// `scripts/gen-spl-fixtures.mjs` so the test here is a round-trip check
// against the generator's intent, not a tautology.
interface FixtureMint {
  kind: 'mint';
  label: string;
  owner: string;
  tokenProgram: 'spl-v1' | 'token-2022';
  dataBase64: string;
  expected: {
    mintAuthority: string | null;
    supply: string;
    decimals: number;
    isInitialized: boolean;
    freezeAuthority: string | null;
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
// Cast through `unknown` because the file is either-or (mint | account)
// and our FixtureMint predicate narrows it to just the mint vectors below.
const allFixtures = JSON.parse(
  readFileSync(FIXTURES_PATH, 'utf8'),
) as Array<FixtureMint | { kind: 'account' }>;
const mintFixtures = allFixtures.filter(
  (f): f is FixtureMint => f.kind === 'mint',
);

function dataFromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

describe('decodeMint', () => {
  it('exposes MINT_ACCOUNT_SIZE = 82 per the SPL layout', () => {
    expect(MINT_ACCOUNT_SIZE).toBe(82);
  });

  for (const fx of mintFixtures) {
    it(`round-trips fixture: ${fx.label}`, () => {
      const data = dataFromBase64(fx.dataBase64);
      const owner = PublicKey.fromBase58(fx.owner);
      const mint = decodeMint({ data, owner });

      expect(mint.supply).toBe(BigInt(fx.expected.supply));
      expect(mint.decimals).toBe(fx.expected.decimals);
      expect(mint.isInitialized).toBe(fx.expected.isInitialized);
      expect(mint.tokenProgram).toBe(fx.expected.tokenProgram);

      if (fx.expected.mintAuthority === null) {
        expect(mint.mintAuthority).toBeNull();
      } else {
        expect(mint.mintAuthority?.toBase58()).toBe(fx.expected.mintAuthority);
      }

      if (fx.expected.freezeAuthority === null) {
        expect(mint.freezeAuthority).toBeNull();
      } else {
        expect(mint.freezeAuthority?.toBase58()).toBe(
          fx.expected.freezeAuthority,
        );
      }

      if (fx.expected.tokenProgram === 'token-2022') {
        // Token-2022 mints always route through the extensions decoder.
        // These fixtures are bare (no TLV region), so we expect empty
        // extensions and no unknown entries — but the fields must exist.
        expect(mint.extensions).toEqual({});
        expect(mint.unknownExtensions).toEqual([]);
      } else {
        // v1 mints never populate extensions — they don't have them at all.
        expect(mint.extensions).toBeUndefined();
        expect(mint.unknownExtensions).toBeUndefined();
      }
    });
  }

  it('throws when data is shorter than MINT_ACCOUNT_SIZE', () => {
    const short = new Uint8Array(81); // one byte too few
    expect(() => decodeMint({ data: short })).toThrow(/data too short/);
  });

  it('throws on a malformed isInitialized byte', () => {
    // Build a minimal valid prefix, then corrupt the `isInitialized` byte at
    // offset 45 to an illegal value.
    const data = new Uint8Array(MINT_ACCOUNT_SIZE);
    data[0] = 0x00; // mintAuthority COption tag = 0 (None)
    // Bytes 1..36 = pubkey slot (zeroed — the None case)
    // Bytes 36..44 = supply (zeroed)
    // Byte 44 = decimals (0)
    data[45] = 0x02; // invalid isInitialized byte
    expect(() => decodeMint({ data })).toThrow(/invalid bool/);
  });

  it('throws on a malformed COption<Pubkey> tag', () => {
    const data = new Uint8Array(MINT_ACCOUNT_SIZE);
    data[0] = 0x02; // tag = 2 is neither None (0) nor Some (1)
    expect(() => decodeMint({ data })).toThrow(/invalid COption/);
  });

  it('defaults tokenProgram to spl-v1 when account.owner is absent', () => {
    const fx = mintFixtures[0]!;
    const data = dataFromBase64(fx.dataBase64);
    const mint = decodeMint({ data });
    expect(mint.tokenProgram).toBe('spl-v1');
  });

  it('reports tokenProgram = spl-v1 when owner is TOKEN_PROGRAM_ID', () => {
    const fx = mintFixtures[0]!;
    const data = dataFromBase64(fx.dataBase64);
    const mint = decodeMint({ data, owner: TOKEN_PROGRAM_ID });
    expect(mint.tokenProgram).toBe('spl-v1');
  });

  it('reports tokenProgram = token-2022 when owner matches Token-2022 program ID', () => {
    const fx = mintFixtures.find((f) => f.tokenProgram === 'token-2022')!;
    const data = dataFromBase64(fx.dataBase64);
    const mint = decodeMint({ data, owner: TOKEN_2022_PROGRAM_ID });
    expect(mint.tokenProgram).toBe('token-2022');
    // Extensions decoder runs — with no TLV region, result is empty.
    expect(mint.extensions).toEqual({});
    expect(mint.unknownExtensions).toEqual([]);
  });
});

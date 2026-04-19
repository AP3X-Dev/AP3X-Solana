import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import { borsh, PublicKey } from '@ap3x/solana-core';

import {
  decodeMetadata,
  type MetadataVersion,
  type TokenStandard,
  type UseMethod,
} from './metadata-decoder';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FixtureCreator {
  address: string;
  verified: boolean;
  share: number;
}

interface FixtureMetadata {
  label: string;
  note: string;
  dataBase64: string;
  expected: {
    version: MetadataVersion;
    key: number;
    updateAuthority: string;
    mint: string;
    name: string;
    symbol: string;
    uri: string;
    sellerFeeBasisPoints: number;
    creators: FixtureCreator[] | null;
    primarySaleHappened: boolean;
    isMutable: boolean;
    editionNonce: number | null;
    tokenStandard: TokenStandard | null;
    collection: { verified: boolean; key: string } | null;
    uses: { useMethod: UseMethod; remaining: string; total: string } | null;
    collectionDetails: { size: string } | null;
  };
}

const FIXTURES_PATH = resolve(
  __dirname,
  '..',
  'tests',
  'fixtures',
  'metadata-synthetic.json',
);
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as FixtureMetadata[];

function dataFromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

describe('decodeMetadata — synthetic fixture round-trips', () => {
  for (const fx of fixtures) {
    it(`round-trips fixture: ${fx.label}`, () => {
      const data = dataFromBase64(fx.dataBase64);
      const md = decodeMetadata(data);

      expect(md.version).toBe(fx.expected.version);
      expect(md.key).toBe(fx.expected.key);
      expect(md.updateAuthority.toBase58()).toBe(fx.expected.updateAuthority);
      expect(md.mint.toBase58()).toBe(fx.expected.mint);
      expect(md.name).toBe(fx.expected.name);
      expect(md.symbol).toBe(fx.expected.symbol);
      expect(md.uri).toBe(fx.expected.uri);
      expect(md.sellerFeeBasisPoints).toBe(fx.expected.sellerFeeBasisPoints);
      expect(md.primarySaleHappened).toBe(fx.expected.primarySaleHappened);
      expect(md.isMutable).toBe(fx.expected.isMutable);
      expect(md.editionNonce).toBe(fx.expected.editionNonce);
      expect(md.tokenStandard).toBe(fx.expected.tokenStandard);

      if (fx.expected.creators === null) {
        expect(md.creators).toBeNull();
      } else {
        expect(md.creators).not.toBeNull();
        expect(md.creators).toHaveLength(fx.expected.creators.length);
        for (let i = 0; i < fx.expected.creators.length; i++) {
          const actual = md.creators![i]!;
          const expected = fx.expected.creators[i]!;
          expect(actual.address.toBase58()).toBe(expected.address);
          expect(actual.verified).toBe(expected.verified);
          expect(actual.share).toBe(expected.share);
        }
      }

      if (fx.expected.collection === null) {
        expect(md.collection).toBeNull();
      } else {
        expect(md.collection).not.toBeNull();
        expect(md.collection!.verified).toBe(fx.expected.collection.verified);
        expect(md.collection!.key.toBase58()).toBe(fx.expected.collection.key);
      }

      if (fx.expected.uses === null) {
        expect(md.uses).toBeNull();
      } else {
        expect(md.uses).not.toBeNull();
        expect(md.uses!.useMethod).toBe(fx.expected.uses.useMethod);
        expect(md.uses!.remaining).toBe(BigInt(fx.expected.uses.remaining));
        expect(md.uses!.total).toBe(BigInt(fx.expected.uses.total));
      }

      if (fx.expected.collectionDetails === null) {
        expect(md.collectionDetails).toBeNull();
      } else {
        expect(md.collectionDetails).not.toBeNull();
        expect(md.collectionDetails!.size).toBe(
          BigInt(fx.expected.collectionDetails.size),
        );
      }
    });
  }
});

// --- Direct error-path tests ---------------------------------------------

describe('decodeMetadata — error paths', () => {
  const UPDATE_AUTH = PublicKey.fromBase58(
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  );
  const MINT = PublicKey.fromBase58(
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  );

  function buildMinimalHeader(
    overrides: {
      creators?: Array<{ address: PublicKey; verified: boolean; share: number }> | null;
      name?: string;
      symbol?: string;
      uri?: string;
    } = {},
  ): borsh.Writer {
    const w = new borsh.Writer();
    w.writeU8(4); // key discriminator
    w.writePubkey(UPDATE_AUTH);
    w.writePubkey(MINT);
    w.writeString(overrides.name ?? 'T');
    w.writeString(overrides.symbol ?? 'T');
    w.writeString(overrides.uri ?? 'u');
    w.writeU16(0);
    // creators (Metaplex COption, 1-byte tag)
    const creators = overrides.creators;
    if (creators === null || creators === undefined) {
      w.writeU8(0);
    } else {
      w.writeU8(1);
      w.writeU32(creators.length);
      for (const c of creators) {
        w.writePubkey(c.address);
        w.writeBool(c.verified);
        w.writeU8(c.share);
      }
    }
    w.writeBool(false); // primarySaleHappened
    w.writeBool(true); // isMutable
    return w;
  }

  it('throws on invalid COption tag for editionNonce', () => {
    const w = buildMinimalHeader();
    w.writeU8(2); // invalid COption tag
    const data = w.toBytes();
    expect(() => decodeMetadata(data)).toThrow(/invalid COption tag/);
  });

  it('throws on invalid COption tag for creators', () => {
    const w = new borsh.Writer();
    w.writeU8(4);
    w.writePubkey(UPDATE_AUTH);
    w.writePubkey(MINT);
    w.writeString('X');
    w.writeString('X');
    w.writeString('x');
    w.writeU16(0);
    w.writeU8(7); // invalid creators COption tag
    expect(() => decodeMetadata(w.toBytes())).toThrow(/invalid COption tag/);
  });

  it('throws on invalid TokenStandard variant', () => {
    const w = buildMinimalHeader();
    w.writeU8(0); // editionNonce = None
    w.writeU8(1); // tokenStandard = Some(...)
    w.writeU8(99); // invalid variant
    expect(() => decodeMetadata(w.toBytes())).toThrow(
      /invalid TokenStandard variant/,
    );
  });

  it('throws on invalid Uses.useMethod variant', () => {
    const w = buildMinimalHeader();
    w.writeU8(0); // editionNonce = None
    w.writeU8(0); // tokenStandard = None
    w.writeU8(0); // collection = None
    w.writeU8(1); // uses = Some
    w.writeU8(42); // invalid useMethod
    w.writeU64(0n);
    w.writeU64(0n);
    expect(() => decodeMetadata(w.toBytes())).toThrow(
      /invalid Uses.useMethod variant/,
    );
  });

  it('throws on unsupported CollectionDetails variant', () => {
    const w = buildMinimalHeader();
    w.writeU8(0); // editionNonce
    w.writeU8(0); // tokenStandard
    w.writeU8(0); // collection
    w.writeU8(0); // uses
    w.writeU8(1); // collectionDetails = Some
    w.writeU8(7); // unknown variant
    w.writeU64(0n);
    expect(() => decodeMetadata(w.toBytes())).toThrow(
      /unsupported CollectionDetails variant/,
    );
  });

  it('truncates cleanly between primarySaleHappened and editionNonce (version=v1)', () => {
    const w = buildMinimalHeader();
    const data = w.toBytes();
    const md = decodeMetadata(data);
    expect(md.version).toBe('v1');
    expect(md.editionNonce).toBeNull();
  });

  it('stays at v1 if the v1.3 block is only partially present', () => {
    // Write editionNonce successfully but only half of the tokenStandard
    // COption — the v1.3 reader should roll back and leave v1.
    const w = buildRawWithEditionNonce();
    // Append an incomplete tokenStandard block (tag present, payload
    // cut off).
    w.writeU8(1); // tokenStandard = Some
    // no variant byte follows → EOF
    const md = decodeMetadata(w.toBytes());
    expect(md.version).toBe('v1');
    expect(md.editionNonce).toBe(17);
    expect(md.tokenStandard).toBeNull();
    expect(md.collection).toBeNull();
    expect(md.uses).toBeNull();
  });

  function buildRawWithEditionNonce(): borsh.Writer {
    const w = new borsh.Writer();
    w.writeU8(4);
    w.writePubkey(UPDATE_AUTH);
    w.writePubkey(MINT);
    w.writeString('T');
    w.writeString('T');
    w.writeString('u');
    w.writeU16(0);
    w.writeU8(0); // creators = None
    w.writeBool(false);
    w.writeBool(true);
    w.writeU8(1); // editionNonce Some
    w.writeU8(17);
    return w;
  }
});

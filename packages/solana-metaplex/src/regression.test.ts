import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PublicKey } from '@ap3x/solana-core';
import { decodeMetadata } from './metadata-decoder';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  HERE,
  '../../../tests/fixtures/metaplex-accounts.json.gz',
);

interface CapturedAccount {
  pubkey: string;
  dataSize: number;
  dataBase64: string;
  decodeError: string | null;
}

interface Fixture {
  capturedAt: string;
  count: number;
  accounts: CapturedAccount[];
}

const suite = existsSync(FIXTURE) ? describe : describe.skip;

suite('Metaplex regression — 200 mainnet metadata accounts', () => {
  const fixture = JSON.parse(
    gunzipSync(readFileSync(FIXTURE)).toString('utf8'),
  ) as Fixture;

  it('fixture is populated', () => {
    expect(fixture.accounts.length).toBe(200);
  });

  it('every account decodes into a structurally valid MetadataAccount', () => {
    for (const a of fixture.accounts) {
      const data = new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
      const decoded = decodeMetadata(data);

      expect(decoded.key, `${a.pubkey} key`).toBe(4);
      expect(decoded.updateAuthority, `${a.pubkey} updateAuthority`).toBeInstanceOf(
        PublicKey,
      );
      expect(decoded.mint, `${a.pubkey} mint`).toBeInstanceOf(PublicKey);
      expect(typeof decoded.name).toBe('string');
      expect(typeof decoded.symbol).toBe('string');
      expect(typeof decoded.uri).toBe('string');
      expect(['v1', 'v1.3', 'current']).toContain(decoded.version);
      expect(typeof decoded.primarySaleHappened).toBe('boolean');
      expect(typeof decoded.isMutable).toBe('boolean');
      expect(decoded.sellerFeeBasisPoints).toBeGreaterThanOrEqual(0);
      expect(decoded.sellerFeeBasisPoints).toBeLessThanOrEqual(10000);
    }
  });

  it('names fit the puffed 32-byte limit and symbols the puffed 10-byte limit', () => {
    for (const a of fixture.accounts) {
      const data = new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
      const decoded = decodeMetadata(data);
      // Puffed limits (name=32, symbol=10, uri=200) are stored length-prefixed;
      // content may be shorter after null-padding is stripped, never longer.
      expect(decoded.name.length, `${a.pubkey} name <= 32`).toBeLessThanOrEqual(32);
      expect(
        decoded.symbol.length,
        `${a.pubkey} symbol <= 10`,
      ).toBeLessThanOrEqual(10);
      expect(decoded.uri.length, `${a.pubkey} uri <= 200`).toBeLessThanOrEqual(200);
    }
  });

  it('creators are well-formed when present', () => {
    let withCreators = 0;
    for (const a of fixture.accounts) {
      const data = new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
      const decoded = decodeMetadata(data);
      if (!decoded.creators) continue;
      withCreators += 1;
      expect(decoded.creators.length).toBeLessThanOrEqual(5);
      let shareTotal = 0;
      for (const c of decoded.creators) {
        expect(c.address).toBeInstanceOf(PublicKey);
        expect(typeof c.verified).toBe('boolean');
        expect(c.share).toBeGreaterThanOrEqual(0);
        expect(c.share).toBeLessThanOrEqual(100);
        shareTotal += c.share;
      }
      // Metaplex enforces creators' share summing to 100 at mint; some older
      // accounts violate this, so we assert the ceiling, not the equality.
      expect(shareTotal, `${a.pubkey} creator share total`).toBeLessThanOrEqual(100);
    }
    expect(withCreators, 'at least some accounts have creators').toBeGreaterThan(0);
  });

  it('version distribution reflects a real mainnet sample', () => {
    const counts = { v1: 0, 'v1.3': 0, current: 0 };
    for (const a of fixture.accounts) {
      const data = new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
      const decoded = decodeMetadata(data);
      counts[decoded.version] += 1;
    }
    // Sanity: at least one account decoded as current-era (implies the
    // tolerance path worked and the v1.3 block read cleanly for most accounts).
    const total = counts.v1 + counts['v1.3'] + counts.current;
    expect(total).toBe(fixture.accounts.length);
    expect(
      counts['v1.3'] + counts.current,
      'majority should reach v1.3+ (200B accounts are 679-byte layouts)',
    ).toBeGreaterThan(counts.v1);
  });
});

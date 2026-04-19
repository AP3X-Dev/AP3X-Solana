import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PublicKey } from '@ap3x/solana-core';
import { decodeMint } from './mint';
import { decodeTokenAccount } from './token-account';
import { TOKEN_PROGRAM_ID } from './program-ids';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../../tests/fixtures/spl-accounts.json.gz');

interface CapturedAccount {
  pubkey: string;
  dataBase64: string;
}

interface Fixture {
  capturedAt: string;
  mintCount: number;
  tokenAccountCount: number;
  mints: CapturedAccount[];
  tokenAccounts: CapturedAccount[];
}

const suite = existsSync(FIXTURE) ? describe : describe.skip;

suite('SPL regression — 500 mainnet mints + 500 token accounts', () => {
  const fixture = JSON.parse(
    gunzipSync(readFileSync(FIXTURE)).toString('utf8'),
  ) as Fixture;

  it('fixture is populated', () => {
    expect(fixture.mints.length).toBe(500);
    expect(fixture.tokenAccounts.length).toBe(500);
  });

  it('decodes every mint into structurally valid output', () => {
    for (const m of fixture.mints) {
      const data = new Uint8Array(Buffer.from(m.dataBase64, 'base64'));
      const decoded = decodeMint({ data, owner: TOKEN_PROGRAM_ID });

      expect(decoded.decimals, `${m.pubkey} decimals`).toBeGreaterThanOrEqual(0);
      expect(decoded.decimals, `${m.pubkey} decimals`).toBeLessThanOrEqual(18);
      expect(typeof decoded.supply).toBe('bigint');
      expect(decoded.supply >= 0n, `${m.pubkey} supply non-negative`).toBe(true);
      expect(typeof decoded.isInitialized).toBe('boolean');
      expect(decoded.tokenProgram).toBe('spl-v1');
      if (decoded.mintAuthority !== null) {
        expect(decoded.mintAuthority).toBeInstanceOf(PublicKey);
      }
      if (decoded.freezeAuthority !== null) {
        expect(decoded.freezeAuthority).toBeInstanceOf(PublicKey);
      }
    }
  });

  it('decodes every token account into structurally valid output', () => {
    for (const a of fixture.tokenAccounts) {
      const data = new Uint8Array(Buffer.from(a.dataBase64, 'base64'));
      const decoded = decodeTokenAccount({ data, owner: TOKEN_PROGRAM_ID });

      expect(decoded.mint, `${a.pubkey} mint`).toBeInstanceOf(PublicKey);
      expect(decoded.owner, `${a.pubkey} owner`).toBeInstanceOf(PublicKey);
      expect(typeof decoded.amount).toBe('bigint');
      expect(decoded.amount >= 0n, `${a.pubkey} amount non-negative`).toBe(true);
      expect(['uninitialized', 'initialized', 'frozen']).toContain(decoded.state);
      expect(decoded.tokenProgram).toBe('spl-v1');
      expect(typeof decoded.delegatedAmount).toBe('bigint');
      if (decoded.delegate !== null) {
        expect(decoded.delegate).toBeInstanceOf(PublicKey);
      }
      if (decoded.closeAuthority !== null) {
        expect(decoded.closeAuthority).toBeInstanceOf(PublicKey);
      }
      if (decoded.isNative !== null) {
        expect(typeof decoded.isNative).toBe('bigint');
      }
    }
  });

  it('round-trip: decoded mint authorities match source bytes', () => {
    // Spot-check invariant: if mintAuthority option tag=1, the embedded 32
    // bytes must equal what decodeMint returns as .toBuffer().
    let checked = 0;
    for (const m of fixture.mints) {
      const data = new Uint8Array(Buffer.from(m.dataBase64, 'base64'));
      const decoded = decodeMint({ data, owner: TOKEN_PROGRAM_ID });
      // SPL COption tag is 4 bytes LE; pubkey is the next 32 bytes.
      const tag = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
      if (tag === 1 && decoded.mintAuthority) {
        const raw = data.slice(4, 36);
        const back = decoded.mintAuthority.toBuffer();
        expect(Array.from(back), `${m.pubkey} mintAuthority bytes`).toEqual(
          Array.from(raw),
        );
        checked += 1;
      }
    }
    expect(checked, 'at least one mint with authority present').toBeGreaterThan(0);
  });
});

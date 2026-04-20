import { describe, expect, it, vi } from 'vitest';
import { PublicKey, HttpClient } from '@ap3x/solana-core';
import {
  MetadataResolver,
  getMetadataPda,
} from '@ap3x/solana-metaplex';

import { metadata } from './metadata.js';

/**
 * Inline captured Metaplex account payload. Copied verbatim from
 * `packages/solana-metaplex/tests/fixtures/metadata-synthetic.json`
 * (label: "v1-bare"). Reusing a fixture that already has cross-package
 * coverage ensures a decoder-layout change surfaces in both suites rather
 * than hiding behind a hand-crafted byte string.
 *
 * The URI in this fixture is `https://example.com/bare-v1.json`, which we
 * intercept via an injected HttpClient whose `get` method returns a canned
 * JSON body — no msw setup, no network, no sleep.
 */
const BARE_V1_DATA_BASE64 =
  'BAtwZbHj0XxFOJ1Sf2sEw81YuGxzGqD9tUm20bwD+ClGxvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWELAAAAQmFyZSB2MSBORlQEAAAAQkFSRSAAAABodHRwczovL2V4YW1wbGUuY29tL2JhcmUtdjEuanNvbvQBAAAB';

const EXPECTED_NAME = 'Bare v1 NFT';
const EXPECTED_URI = 'https://example.com/bare-v1.json';
// `updateAuthority` = METADATA_PROGRAM_ID in this fixture — a convenient
// sentinel because it's a known deterministic pubkey.
const EXPECTED_UPDATE_AUTHORITY = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
// Mint field inside the decoded account (independent of the mint we pass
// into `metadata()` — the PDA is derived from that one, the decoded
// `mint` comes from the account bytes).
const FIXTURE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Stub HttpClient that returns a fixed JSON body for any URL. We override
 * `get` directly rather than trying to satisfy the full HttpClient surface —
 * MetadataResolver only calls `get(uri)` and then `.text()` on the result.
 */
function stubHttp(body: string): HttpClient {
  const http = new HttpClient({ timeoutMs: 1000 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (http as any).get = vi.fn(async (_uri: string) => ({
    text: async () => body,
  }));
  return http;
}

describe('metadata', () => {
  it('composes getAccountInfo → decodeMetadata → resolver.resolve into one PumpFunMetadata', async () => {
    const mint = PublicKey.fromBase58(FIXTURE_MINT);
    const { address: expectedPda } = getMetadataPda(mint);

    // --- RPC stub -----------------------------------------------------------
    const call = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe('getAccountInfo');
      const arr = params as unknown[];
      expect(arr[0]).toBe(expectedPda.toBase58());
      // encoding must be base64 so the decoder gets raw bytes.
      expect((arr[1] as { encoding: string }).encoding).toBe('base64');
      return { value: { data: [BARE_V1_DATA_BASE64, 'base64'] } };
    });
    const pool = { call } as unknown as Parameters<typeof metadata>[0];

    // --- Off-chain resolver stub -------------------------------------------
    const offChainBody = JSON.stringify({
      name: EXPECTED_NAME,
      symbol: 'BARE',
      description: 'Off-chain description',
      image: 'https://example.com/bare.png',
    });
    const resolver = new MetadataResolver({ httpClient: stubHttp(offChainBody) });

    const result = await metadata(pool, resolver, mint);

    // On-chain side -- decoded directly by the shared Metaplex decoder.
    expect(result.onChain.name).toBe(EXPECTED_NAME);
    expect(result.onChain.uri).toBe(EXPECTED_URI);
    expect(result.onChain.mint.toBase58()).toBe(FIXTURE_MINT);
    expect(result.onChain.updateAuthority.toBase58()).toBe(
      EXPECTED_UPDATE_AUTHORITY,
    );

    // Off-chain side -- the resolver's happy-path output makes it through.
    expect(result.offChain.source).toBe('network');
    expect(result.offChain.parsed?.name).toBe(EXPECTED_NAME);
    expect(result.offChain.parsed?.image).toBe('https://example.com/bare.png');
    expect(result.offChain.parseErrors).toBeUndefined();

    // Exactly one RPC round-trip — no speculative extra reads.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('throws when the metadata account is missing (value: null)', async () => {
    const mint = PublicKey.fromBase58(FIXTURE_MINT);
    const call = vi.fn(async () => ({ value: null }));
    const pool = { call } as unknown as Parameters<typeof metadata>[0];
    const resolver = new MetadataResolver({ httpClient: stubHttp('{}') });
    await expect(metadata(pool, resolver, mint)).rejects.toThrow(
      /metadata account not found/,
    );
  });

  it('surfaces resolver parseErrors when the off-chain JSON is malformed', async () => {
    const mint = PublicKey.fromBase58(FIXTURE_MINT);
    const call = vi.fn(async () => ({
      value: { data: [BARE_V1_DATA_BASE64, 'base64'] },
    }));
    const pool = { call } as unknown as Parameters<typeof metadata>[0];
    // Broken JSON — resolver must NOT throw, must surface parseErrors.
    const resolver = new MetadataResolver({ httpClient: stubHttp('{not json') });

    const result = await metadata(pool, resolver, mint);
    expect(result.offChain.parsed).toBeUndefined();
    expect(result.offChain.parseErrors).toBeDefined();
    expect(result.offChain.parseErrors!.length).toBeGreaterThan(0);
  });
});

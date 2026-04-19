import { describe, it, expect } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';

import type { MetadataAccount } from './metadata-decoder';
import { isCollectionMember, verifyCreator } from './collection';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const UPDATE_AUTH = PublicKey.fromBase58(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);
const MINT = PublicKey.fromBase58(
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
);
const PARENT_A = PublicKey.fromBase58(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
const PARENT_B = PublicKey.fromBase58(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);
const CREATOR_A = PublicKey.fromBase58(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
);
const CREATOR_B = PublicKey.fromBase58(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/**
 * Build a minimal MetadataAccount fixture carrying only the fields our
 * helpers read. The rest are filled with plausible defaults so the
 * structure is still valid; tests override just what they need.
 */
function makeMetadata(
  overrides: Partial<MetadataAccount> = {},
): MetadataAccount {
  return {
    version: 'v1.3',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT,
    name: 'T',
    symbol: 'T',
    uri: 'https://example.com/t.json',
    sellerFeeBasisPoints: 0,
    creators: null,
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: null,
    tokenStandard: 'NonFungible',
    collection: null,
    uses: null,
    collectionDetails: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isCollectionMember
// ---------------------------------------------------------------------------

describe('isCollectionMember', () => {
  it('returns true for a verified collection matching the parent', () => {
    const md = makeMetadata({
      collection: { verified: true, key: PARENT_A },
    });
    expect(isCollectionMember(md, PARENT_A)).toBe(true);
  });

  it('returns false when the collection pointer is null', () => {
    const md = makeMetadata({ collection: null });
    expect(isCollectionMember(md, PARENT_A)).toBe(false);
  });

  it('returns false when collection is unverified (spoofing guard)', () => {
    const md = makeMetadata({
      collection: { verified: false, key: PARENT_A },
    });
    expect(isCollectionMember(md, PARENT_A)).toBe(false);
  });

  it('returns false when collection key differs', () => {
    const md = makeMetadata({
      collection: { verified: true, key: PARENT_B },
    });
    expect(isCollectionMember(md, PARENT_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyCreator
// ---------------------------------------------------------------------------

describe('verifyCreator', () => {
  it('returns true for a verified creator in the list', () => {
    const md = makeMetadata({
      creators: [
        { address: CREATOR_A, verified: true, share: 60 },
        { address: CREATOR_B, verified: false, share: 40 },
      ],
    });
    expect(verifyCreator(md, CREATOR_A)).toBe(true);
  });

  it('returns false when creators list is null', () => {
    const md = makeMetadata({ creators: null });
    expect(verifyCreator(md, CREATOR_A)).toBe(false);
  });

  it('returns false when creator is present but unverified', () => {
    const md = makeMetadata({
      creators: [{ address: CREATOR_A, verified: false, share: 100 }],
    });
    expect(verifyCreator(md, CREATOR_A)).toBe(false);
  });

  it('returns false when creator is not in the list', () => {
    const md = makeMetadata({
      creators: [{ address: CREATOR_B, verified: true, share: 100 }],
    });
    expect(verifyCreator(md, CREATOR_A)).toBe(false);
  });

  it('returns false for an empty creators list', () => {
    const md = makeMetadata({ creators: [] });
    expect(verifyCreator(md, CREATOR_A)).toBe(false);
  });
});

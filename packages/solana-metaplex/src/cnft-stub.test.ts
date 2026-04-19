import { describe, it, expect } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';

import { defaultCompressedMetadataReader } from './cnft-stub';

describe('defaultCompressedMetadataReader', () => {
  it('throws the deferral sentinel exactly', async () => {
    const asset = PublicKey.fromBase58(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    await expect(defaultCompressedMetadataReader.read(asset)).rejects.toThrow(
      'cNFT support deferred to magic-eden vertical',
    );
  });

  it('throws regardless of input asset', async () => {
    const asset = PublicKey.fromBase58(
      'So11111111111111111111111111111111111111112',
    );
    await expect(
      defaultCompressedMetadataReader.read(asset),
    ).rejects.toThrowError(/cNFT support deferred/);
  });
});

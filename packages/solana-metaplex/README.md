# @ap3x/solana-metaplex

Metaplex Token Metadata support for the AP3X Solana runtime: PDA derivation, an on-chain account decoder, an off-chain JSON resolver, and collection/creator checks.

## Overview

`@ap3x/solana-metaplex` reads Metaplex metadata without any `@metaplex-foundation/*` dependency. The decoder is hand-rolled over the `@ap3x/solana-core` Borsh reader and handles the v1, v1.3 and current account layouts. Accounts cut short at an older layout decode as that older version and are not treated as errors.

## Key exports

- `METADATA_PROGRAM_ID`, `getMetadataPda(mint)` — returns `MetadataPda` (`{ address, bump }`).
- `decodeMetadata(data)` — returns a `MetadataAccount` with `version` (`'v1' | 'v1.3' | 'current'`), `updateAuthority`, `mint`, `name`, `symbol` and `uri` (null padding stripped), `sellerFeeBasisPoints`, `creators`, `primarySaleHappened`, `isMutable`, `editionNonce`, `tokenStandard`, `collection`, `uses` and `collectionDetails`. Optional fields are `null` when absent.
- `MetadataResolver` — `resolve(uri)` fetches and caches the off-chain JSON. It checks an in-memory LRU, then an optional file cache (`fileCacheDir`), then the network. Malformed JSON or bad fields go into `parseErrors`, and only a total fetch failure throws. `ResolvedMetadata.source` says which layer answered. `clearCache()` clears the memory layer only.
- `extractShape(value)` — the field extraction and validation step used by the resolver.
- `isCollectionMember(child, parentMint)`, `verifyCreator(metadata, creator)` — return `true` only when the matching entry's `verified` flag is set.
- `CompressedMetadataReader`, `defaultCompressedMetadataReader` — the extension point for compressed NFTs. The default implementation always throws, because compressed-NFT support belongs in a vertical package.

## Usage

```ts
import { decodeMetadata, getMetadataPda, isCollectionMember, MetadataResolver } from '@ap3x/solana-metaplex';

const { address } = getMetadataPda(mint);
// fetch `address` account data with your RPC layer, then:
const meta = decodeMetadata(accountData);

const resolver = new MetadataResolver({ fileCacheDir: '.cache/metadata' });
const { parsed, parseErrors, source } = await resolver.resolve(meta.uri);

isCollectionMember(meta, collectionMint);
```

## Conventions

- Metaplex `COption` uses a 1-byte tag. SPL's `COption` uses a 4-byte tag, so do not mix the two readers.
- Unverified collection pointers and creators never count as membership.

## Boundary

`solana-metaplex` may import from `core` and `tx`. From `tx` it may import only `findProgramAddress`, and it must not import `@ap3x/solana-connectivity` directly: pass RPC access in as a parameter.

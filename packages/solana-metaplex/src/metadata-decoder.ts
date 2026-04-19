/**
 * Metaplex Token Metadata account decoder — handles v1, v1.3, and current
 * (pNFT) revisions of the on-chain layout.
 *
 * Layout reference (Metaplex Token Metadata Program):
 *
 *     offset  size                       field
 *     ------  -------------------------  -----
 *     0       1                          key (discriminator; 4 = MetadataV1)
 *     1       32                         updateAuthority
 *     33      32                         mint
 *     --- Data struct ---
 *     65      u32 + N  (u32 + up to 32)  name
 *     ..      u32 + N  (u32 + up to 10)  symbol
 *     ..      u32 + N  (u32 + up to 200) uri
 *     ..      2                          sellerFeeBasisPoints (u16 LE)
 *     ..      COption<Vec<Creator>>      creators (1-byte tag + optional vec)
 *     --- end Data ---
 *     ..      1                          primarySaleHappened
 *     ..      1                          isMutable
 *     --- v1.1+ ---
 *     ..      COption<u8>                editionNonce      (1 + 1)
 *     --- v1.2+ ---
 *     ..      COption<TokenStandard>     tokenStandard     (1 + 1)
 *     ..      COption<Collection>        collection        (1 + 33)
 *     ..      COption<Uses>              uses              (1 + 17)
 *     --- v1.3+ ---
 *     ..      COption<CollectionDetails> collectionDetails (1 + 9 for V1)
 *     --- current (pNFT) ---
 *     ..      COption<ProgrammableConfig> programmableConfig (1 + 33)
 *
 * Metaplex's string encoding is standard Borsh (u32 LE byte length + UTF-8
 * bytes). Older versions of the program used `puffed_out_string` to pad the
 * string bytes out to `MAX_NAME_LEN` / `MAX_SYMBOL_LEN` / `MAX_URI_LEN`
 * BEFORE serializing, so the stored string bytes often contain trailing
 * zero padding. We strip those on read (`stripNulPadding`) to match the
 * user-facing values the creator originally passed.
 *
 * Metaplex uses Borsh-style `COption<T>` (1-byte tag — 0=None, 1=Some),
 * NOT SPL's 4-byte COption. Keep that straight: this decoder implements
 * only the 1-byte flavour.
 *
 * Version detection is best-effort. We start at v1 and upgrade the version
 * tag as we successfully consume each trailing optional block. A read that
 * runs off the end is treated as "this version didn't include that field",
 * NOT a parse error — many real accounts on-chain are truncated at v1 or
 * v1.3 despite the program now emitting the current layout.
 *
 * Zero ecosystem-SDK deps: only `@ap3x/solana-core`.
 */

import { borsh, PublicKey } from '@ap3x/solana-core';
import type { Reader } from '@ap3x/solana-core';

/** Published revision of the Metaplex Metadata layout a decoded account conforms to. */
export type MetadataVersion = 'v1' | 'v1.3' | 'current';

/** Metaplex TokenStandard enum values (matches on-chain variant indices). */
export type TokenStandard =
  | 'NonFungible'
  | 'FungibleAsset'
  | 'Fungible'
  | 'NonFungibleEdition'
  | 'ProgrammableNonFungible';

const TOKEN_STANDARD_VARIANTS: readonly TokenStandard[] = [
  'NonFungible',
  'FungibleAsset',
  'Fungible',
  'NonFungibleEdition',
  'ProgrammableNonFungible',
];

/** Metaplex UseMethod enum values. */
export type UseMethod = 'Burn' | 'Multiple' | 'Single';

const USE_METHOD_VARIANTS: readonly UseMethod[] = ['Burn', 'Multiple', 'Single'];

/** Single verified-creator entry inside a Metadata account. */
export interface Creator {
  address: PublicKey;
  verified: boolean;
  share: number;
}

/** Verified-collection pointer (parent collection mint + verification flag). */
export interface CollectionField {
  verified: boolean;
  key: PublicKey;
}

/** Use-limit tracking appended in v1.2+. */
export interface UsesField {
  useMethod: UseMethod;
  remaining: bigint;
  total: bigint;
}

/** CollectionDetails.V1 block (sized parent collection). */
export interface CollectionDetailsField {
  size: bigint;
}

/** Fully-decoded Metaplex Metadata account. */
export interface MetadataAccount {
  /**
   * Which revision of the layout this account conforms to. Heuristic: we
   * mark the highest tier whose trailing optional block we successfully
   * consumed.
   */
  version: MetadataVersion;
  /** Discriminator byte (should be 4 for MetadataV1 accounts). */
  key: number;
  /** Account allowed to mutate the metadata (unless `isMutable` is false). */
  updateAuthority: PublicKey;
  /** Mint this metadata describes. */
  mint: PublicKey;
  /** Human-readable name. Trailing null padding is stripped. */
  name: string;
  /** Short symbol (ticker). Trailing null padding is stripped. */
  symbol: string;
  /** Off-chain metadata JSON URI. Trailing null padding is stripped. */
  uri: string;
  /** Seller fee in basis points (0..10000). */
  sellerFeeBasisPoints: number;
  /** Creator split. `null` when the COption tag was 0 (no creators). */
  creators: Creator[] | null;
  /** Has the primary sale happened. */
  primarySaleHappened: boolean;
  /** Is the metadata still mutable by `updateAuthority`. */
  isMutable: boolean;
  /** v1.1+. Edition marker nonce. `null` when the field is absent or COption=0. */
  editionNonce: number | null;
  /** v1.2+. Token standard tag. `null` when the field is absent or COption=0. */
  tokenStandard: TokenStandard | null;
  /** v1.2+. Parent collection pointer. `null` when absent or COption=0. */
  collection: CollectionField | null;
  /** v1.2+. Use-limit tracking. `null` when absent or COption=0. */
  uses: UsesField | null;
  /** v1.3+. Collection size info. `null` when absent or COption=0. */
  collectionDetails: CollectionDetailsField | null;
}

/**
 * Read a Metaplex-style `COption<T>` — a 1-byte tag (0|1) followed by the
 * payload if tag=1. Distinct from SPL's 4-byte COption; callers that mix
 * SPL and Metaplex parsing need to keep them straight.
 *
 * Any tag value other than 0 or 1 throws — that's an on-chain anomaly we
 * refuse to paper over.
 */
function readMetaplexCOption<T>(
  r: Reader,
  field: string,
  read: (r: Reader) => T,
): T | null {
  const tag = r.readU8();
  if (tag === 0) return null;
  if (tag === 1) return read(r);
  throw new Error(
    `metaplex: invalid COption tag ${tag} for ${field} — expected 0 or 1`,
  );
}

/**
 * Strip trailing `\u0000` bytes from a decoded string. Older revisions of
 * the Metaplex program zero-padded name/symbol/uri out to their respective
 * maxima before serializing; the padding bytes are meaningless and would
 * otherwise trip equality checks against the creator-supplied value.
 */
function stripNulPadding(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}

function readCreator(r: Reader): Creator {
  const address = r.readPubkey();
  const verified = r.readBool();
  const share = r.readU8();
  return { address, verified, share };
}

function readCollection(r: Reader): CollectionField {
  const verified = r.readBool();
  const key = r.readPubkey();
  return { verified, key };
}

function readUses(r: Reader): UsesField {
  const methodByte = r.readU8();
  const useMethod = USE_METHOD_VARIANTS[methodByte];
  if (!useMethod) {
    throw new Error(
      `metaplex: invalid Uses.useMethod variant ${methodByte} — expected 0..2`,
    );
  }
  const remaining = r.readU64();
  const total = r.readU64();
  return { useMethod, remaining, total };
}

/**
 * Read a `CollectionDetails` variant. The on-chain enum has only one
 * variant today — `V1 { size: u64 }` — stored as `[0 variant-tag][u64 size]`.
 * Future variants would bump the tag; we refuse to guess about their
 * shape.
 */
function readCollectionDetails(r: Reader): CollectionDetailsField {
  const variant = r.readU8();
  if (variant !== 0) {
    throw new Error(
      `metaplex: unsupported CollectionDetails variant ${variant} — only V1 (size:u64) is known`,
    );
  }
  const size = r.readU64();
  return { size };
}

/** Read a token-standard enum byte, mapping it to the string variant name. */
function readTokenStandard(r: Reader): TokenStandard {
  const b = r.readU8();
  const v = TOKEN_STANDARD_VARIANTS[b];
  if (!v) {
    throw new Error(
      `metaplex: invalid TokenStandard variant ${b} — expected 0..4`,
    );
  }
  return v;
}

/**
 * Decode a Metaplex Token Metadata account. See the module docstring for
 * the full layout + version strategy.
 *
 * @throws Error on obviously malformed base fields (truncated header,
 *         invalid bool / pubkey length, out-of-range enum tags). Missing
 *         trailing optional blocks are NOT errors — they just downgrade
 *         the reported `version`.
 */
export function decodeMetadata(data: Uint8Array): MetadataAccount {
  const r = new borsh.Reader(data);

  // --- Base header (always present) -------------------------------------
  const key = r.readU8();
  const updateAuthority = r.readPubkey();
  const mint = r.readPubkey();

  const name = stripNulPadding(r.readString());
  const symbol = stripNulPadding(r.readString());
  const uri = stripNulPadding(r.readString());
  const sellerFeeBasisPoints = r.readU16();

  const creators = readMetaplexCOption<Creator[]>(r, 'creators', (rr) =>
    rr.readVec(readCreator),
  );

  const primarySaleHappened = r.readBool();
  const isMutable = r.readBool();

  // Start with v1 and upgrade as we consume optional trailing blocks.
  let version: MetadataVersion = 'v1';
  let editionNonce: number | null = null;
  let tokenStandard: TokenStandard | null = null;
  let collection: CollectionField | null = null;
  let uses: UsesField | null = null;
  let collectionDetails: CollectionDetailsField | null = null;

  // --- v1.1: editionNonce (COption<u8>) ---------------------------------
  // Each trailing block is wrapped in try/catch against EOF so truncated
  // on-chain records decode cleanly at the last observed version. Invalid
  // bytes inside a block still propagate — we only tolerate "ran off the
  // end", not "garbage bytes".
  const beforeV11 = r.offset;
  try {
    if (r.remaining() > 0) {
      editionNonce = readMetaplexCOption<number>(r, 'editionNonce', (rr) =>
        rr.readU8(),
      );
    }
  } catch (err) {
    if (!isEndOfBuffer(err)) throw err;
    r.offset = beforeV11;
    return {
      version,
      key,
      updateAuthority,
      mint,
      name,
      symbol,
      uri,
      sellerFeeBasisPoints,
      creators,
      primarySaleHappened,
      isMutable,
      editionNonce,
      tokenStandard,
      collection,
      uses,
      collectionDetails,
    };
  }

  // --- v1.3 block: tokenStandard, collection, uses ---------------------
  const beforeV13 = r.offset;
  try {
    if (r.remaining() > 0) {
      tokenStandard = readMetaplexCOption<TokenStandard>(
        r,
        'tokenStandard',
        readTokenStandard,
      );
      collection = readMetaplexCOption<CollectionField>(
        r,
        'collection',
        readCollection,
      );
      uses = readMetaplexCOption<UsesField>(r, 'uses', readUses);
      version = 'v1.3';
    }
  } catch (err) {
    if (!isEndOfBuffer(err)) throw err;
    // Partial v1.3 block — roll back and stay at v1.
    r.offset = beforeV13;
    tokenStandard = null;
    collection = null;
    uses = null;
    return {
      version,
      key,
      updateAuthority,
      mint,
      name,
      symbol,
      uri,
      sellerFeeBasisPoints,
      creators,
      primarySaleHappened,
      isMutable,
      editionNonce,
      tokenStandard,
      collection,
      uses,
      collectionDetails,
    };
  }

  // --- current: collectionDetails (+ programmable_config, which we
  //     skip — we don't yet surface a typed value for the rule set, so
  //     we simply stop reading once we've decoded collectionDetails).
  const beforeCurrent = r.offset;
  try {
    if (r.remaining() > 0) {
      collectionDetails = readMetaplexCOption<CollectionDetailsField>(
        r,
        'collectionDetails',
        readCollectionDetails,
      );
      version = 'current';
    }
  } catch (err) {
    if (!isEndOfBuffer(err)) throw err;
    r.offset = beforeCurrent;
    collectionDetails = null;
    // Keep version at v1.3 — the v1.3 block read cleanly.
  }

  return {
    version,
    key,
    updateAuthority,
    mint,
    name,
    symbol,
    uri,
    sellerFeeBasisPoints,
    creators,
    primarySaleHappened,
    isMutable,
    editionNonce,
    tokenStandard,
    collection,
    uses,
    collectionDetails,
  };
}

/**
 * Is this error the `borsh: unexpected end of buffer ...` sentinel our
 * {@link borsh.Reader} throws when asked for more bytes than remain?
 * Used to distinguish truncated-record tolerance from genuine parser
 * errors (bad enum tag, invalid bool, etc.).
 */
function isEndOfBuffer(err: unknown): boolean {
  return (
    err instanceof Error && err.message.startsWith('borsh: unexpected end of buffer')
  );
}

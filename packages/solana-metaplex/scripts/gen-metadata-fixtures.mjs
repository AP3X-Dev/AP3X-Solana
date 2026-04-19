// One-shot generator for solana-metaplex Metadata fixtures.
//
// Uses only primitive arithmetic + base58 (bitcoin alphabet) — NO
// @solana/* dependencies. Each vector is hand-crafted to exercise a
// specific decoder edge case (layout version, optional blocks, pNFT)
// and committed as the source of truth.
//
// Run:
//   node packages/solana-metaplex/scripts/gen-metadata-fixtures.mjs > \
//     packages/solana-metaplex/tests/fixtures/metadata-synthetic.json

import { Buffer } from 'node:buffer';

// -- base58 (bitcoin alphabet) --------------------------------------------

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) MAP[ALPHABET.charCodeAt(i)] = i;

function b58decode(str) {
  if (str.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  let n = 0n;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const v = code < 128 ? MAP[code] : -1;
    if (v < 0) throw new Error(`invalid base58 char: ${str[i]}`);
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[i];
  return out;
}

function b58encode(bytes) {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = Number(n % 58n);
    n /= 58n;
    out = ALPHABET[r] + out;
  }
  return '1'.repeat(zeros) + out;
}

// -- Sample pubkeys -------------------------------------------------------

const UPDATE_AUTH = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const MINT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_B = 'So11111111111111111111111111111111111111112';
const MINT_C = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const CREATOR_1 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const CREATOR_2 = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COLLECTION_KEY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PROG_RULESET = '11111111111111111111111111111111';

// -- Writers --------------------------------------------------------------

class W {
  constructor() {
    this.chunks = [];
  }
  u8(v) {
    this.chunks.push(new Uint8Array([v & 0xff]));
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xffff, true);
    this.chunks.push(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.chunks.push(b);
  }
  u64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this.chunks.push(b);
  }
  pubkey(b58) {
    this.chunks.push(b58decode(b58));
  }
  bytes(arr) {
    this.chunks.push(arr);
  }
  // Borsh string: u32 LE byte length + UTF-8 bytes.
  // `padTo` optionally zero-pads to emulate puffed_out_string.
  string(s, padTo) {
    const raw = new TextEncoder().encode(s);
    const buf = padTo !== undefined && raw.length < padTo
      ? new Uint8Array(padTo)
      : raw;
    if (padTo !== undefined) buf.set(raw, 0);
    this.u32(buf.length);
    this.chunks.push(buf);
  }
  // Metaplex-style COption: 1-byte tag, payload if present.
  option(present, writer) {
    if (!present) {
      this.u8(0);
      return;
    }
    this.u8(1);
    writer(this);
  }
  build() {
    let n = 0;
    for (const c of this.chunks) n += c.length;
    const out = new Uint8Array(n);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

// -- Core header writer ---------------------------------------------------

function writeHeader(w, { key = 4, updateAuthority, mint, name, symbol, uri, sellerFeeBasisPoints, creators, primarySaleHappened, isMutable, padStrings = false }) {
  w.u8(key);
  w.pubkey(updateAuthority);
  w.pubkey(mint);
  w.string(name, padStrings ? 32 : undefined);
  w.string(symbol, padStrings ? 10 : undefined);
  w.string(uri, padStrings ? 200 : undefined);
  w.u16(sellerFeeBasisPoints);

  if (creators === null) {
    w.u8(0); // COption = None
  } else {
    w.u8(1); // COption = Some
    w.u32(creators.length);
    for (const c of creators) {
      w.pubkey(c.address);
      w.u8(c.verified ? 1 : 0);
      w.u8(c.share);
    }
  }
  w.u8(primarySaleHappened ? 1 : 0);
  w.u8(isMutable ? 1 : 0);
}

// -- Vectors --------------------------------------------------------------

const vectors = [];

function push(label, note, spec, writer) {
  const w = new W();
  writer(w);
  const bytes = w.build();
  vectors.push({
    label,
    note,
    dataBase64: Buffer.from(bytes).toString('base64'),
    expected: spec,
  });
}

// 1. Bare v1 — no optional trailing blocks at all (truncated right after
//    primarySaleHappened / isMutable).
push(
  'v1-bare',
  'Base Data struct + primary_sale + mutable; no edition_nonce, no v1.3 block.',
  {
    version: 'v1',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_A,
    name: 'Bare v1 NFT',
    symbol: 'BARE',
    uri: 'https://example.com/bare-v1.json',
    sellerFeeBasisPoints: 500,
    creators: null,
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: null,
    tokenStandard: null,
    collection: null,
    uses: null,
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_A,
      name: 'Bare v1 NFT',
      symbol: 'BARE',
      uri: 'https://example.com/bare-v1.json',
      sellerFeeBasisPoints: 500,
      creators: null,
      primarySaleHappened: false,
      isMutable: true,
    });
  },
);

// 2. v1 with puffed padding on the strings (the `puffed_out_string` flavour).
push(
  'v1-puffed-strings',
  'Older program emitted zero-padded name/symbol/uri; decoder strips the padding.',
  {
    version: 'v1',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_B,
    name: 'Puffed',
    symbol: 'PUF',
    uri: 'https://example.com/puffed.json',
    sellerFeeBasisPoints: 250,
    creators: null,
    primarySaleHappened: true,
    isMutable: false,
    editionNonce: null,
    tokenStandard: null,
    collection: null,
    uses: null,
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_B,
      name: 'Puffed',
      symbol: 'PUF',
      uri: 'https://example.com/puffed.json',
      sellerFeeBasisPoints: 250,
      creators: null,
      primarySaleHappened: true,
      isMutable: false,
      padStrings: true,
    });
  },
);

// 3. v1.3 with TokenStandard + verified collection, no uses.
push(
  'v13-collection-verified',
  'TokenStandard=NonFungible + verified collection; uses=None; no collectionDetails.',
  {
    version: 'v1.3',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_A,
    name: 'Collection NFT',
    symbol: 'COLL',
    uri: 'https://example.com/coll.json',
    sellerFeeBasisPoints: 100,
    creators: null,
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: 254,
    tokenStandard: 'NonFungible',
    collection: { verified: true, key: COLLECTION_KEY },
    uses: null,
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_A,
      name: 'Collection NFT',
      symbol: 'COLL',
      uri: 'https://example.com/coll.json',
      sellerFeeBasisPoints: 100,
      creators: null,
      primarySaleHappened: false,
      isMutable: true,
    });
    // editionNonce
    w.u8(1);
    w.u8(254);
    // tokenStandard = Some(NonFungible=0)
    w.u8(1);
    w.u8(0);
    // collection = Some({verified:true, key})
    w.u8(1);
    w.u8(1);
    w.pubkey(COLLECTION_KEY);
    // uses = None
    w.u8(0);
  },
);

// 4. v1.3 with unverified creators + Uses field populated.
push(
  'v13-creators-and-uses',
  'Unverified creators, Uses.Multiple remaining=5 total=10.',
  {
    version: 'v1.3',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_C,
    name: 'Uses NFT',
    symbol: 'USES',
    uri: 'https://example.com/uses.json',
    sellerFeeBasisPoints: 750,
    creators: [
      { address: CREATOR_1, verified: false, share: 60 },
      { address: CREATOR_2, verified: false, share: 40 },
    ],
    primarySaleHappened: true,
    isMutable: true,
    editionNonce: null,
    tokenStandard: 'NonFungible',
    collection: null,
    uses: { useMethod: 'Multiple', remaining: '5', total: '10' },
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_C,
      name: 'Uses NFT',
      symbol: 'USES',
      uri: 'https://example.com/uses.json',
      sellerFeeBasisPoints: 750,
      creators: [
        { address: CREATOR_1, verified: false, share: 60 },
        { address: CREATOR_2, verified: false, share: 40 },
      ],
      primarySaleHappened: true,
      isMutable: true,
    });
    // editionNonce = None
    w.u8(0);
    // tokenStandard = Some(NonFungible)
    w.u8(1);
    w.u8(0);
    // collection = None
    w.u8(0);
    // uses = Some(Multiple=1, rem=5, total=10)
    w.u8(1);
    w.u8(1);
    w.u64(5n);
    w.u64(10n);
  },
);

// 5. v1 with empty creators list (COption Some, len=0) → still reports creators=[]
push(
  'v1-empty-creators',
  'Creators present but empty vec; decoder returns [] not null.',
  {
    version: 'v1',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_B,
    name: 'Empty Creators',
    symbol: 'ZERO',
    uri: 'https://example.com/zero.json',
    sellerFeeBasisPoints: 0,
    creators: [],
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: null,
    tokenStandard: null,
    collection: null,
    uses: null,
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_B,
      name: 'Empty Creators',
      symbol: 'ZERO',
      uri: 'https://example.com/zero.json',
      sellerFeeBasisPoints: 0,
      creators: [],
      primarySaleHappened: false,
      isMutable: true,
    });
  },
);

// 6. v1 with creators = null (COption=None)
push(
  'v1-null-creators',
  'Creators COption tag = 0 (truly absent, not empty).',
  {
    version: 'v1',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_A,
    name: 'Null Creators',
    symbol: 'NULL',
    uri: 'https://example.com/null.json',
    sellerFeeBasisPoints: 0,
    creators: null,
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: null,
    tokenStandard: null,
    collection: null,
    uses: null,
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_A,
      name: 'Null Creators',
      symbol: 'NULL',
      uri: 'https://example.com/null.json',
      sellerFeeBasisPoints: 0,
      creators: null,
      primarySaleHappened: false,
      isMutable: true,
    });
  },
);

// 7. Current with verified creators + verified collection + no uses + collectionDetails.size=1000.
push(
  'current-collection-details',
  'Parent-collection record with CollectionDetails.V1 { size: 1000 }.',
  {
    version: 'current',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_B,
    name: 'Parent Collection',
    symbol: 'PAR',
    uri: 'https://example.com/parent.json',
    sellerFeeBasisPoints: 500,
    creators: [{ address: CREATOR_1, verified: true, share: 100 }],
    primarySaleHappened: true,
    isMutable: true,
    editionNonce: null,
    tokenStandard: 'NonFungible',
    collection: null,
    uses: null,
    collectionDetails: { size: '1000' },
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_B,
      name: 'Parent Collection',
      symbol: 'PAR',
      uri: 'https://example.com/parent.json',
      sellerFeeBasisPoints: 500,
      creators: [{ address: CREATOR_1, verified: true, share: 100 }],
      primarySaleHappened: true,
      isMutable: true,
    });
    // editionNonce = None
    w.u8(0);
    // tokenStandard = Some(NonFungible)
    w.u8(1);
    w.u8(0);
    // collection = None
    w.u8(0);
    // uses = None
    w.u8(0);
    // collectionDetails = Some(V1{size:1000})
    w.u8(1);
    w.u8(0); // variant V1
    w.u64(1000n);
  },
);

// 8. pNFT — ProgrammableNonFungible with ProgrammableConfig ruleset present.
//    The decoder doesn't surface a typed ruleset; we still write it out
//    to exercise the "trailing bytes we don't decode" tolerance.
push(
  'current-pnft',
  'ProgrammableNonFungible with trailing ProgrammableConfig(ruleset) bytes.',
  {
    version: 'current',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_C,
    name: 'Programmable',
    symbol: 'PNFT',
    uri: 'https://example.com/pnft.json',
    sellerFeeBasisPoints: 1000,
    creators: [{ address: CREATOR_1, verified: true, share: 100 }],
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: 255,
    tokenStandard: 'ProgrammableNonFungible',
    collection: null,
    uses: null,
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_C,
      name: 'Programmable',
      symbol: 'PNFT',
      uri: 'https://example.com/pnft.json',
      sellerFeeBasisPoints: 1000,
      creators: [{ address: CREATOR_1, verified: true, share: 100 }],
      primarySaleHappened: false,
      isMutable: true,
    });
    // editionNonce = Some(255)
    w.u8(1);
    w.u8(255);
    // tokenStandard = Some(ProgrammableNonFungible = 4)
    w.u8(1);
    w.u8(4);
    // collection = None
    w.u8(0);
    // uses = None
    w.u8(0);
    // collectionDetails = None
    w.u8(0);
    // programmable_config = Some(V1{ Some(ruleset) })
    w.u8(1);
    w.u8(0); // variant V1
    w.u8(1); // rule_set = Some
    w.pubkey(PROG_RULESET);
  },
);

// 9. v1.3 with unverified collection pointer.
push(
  'v13-collection-unverified',
  'Collection present but verified=false; isCollectionMember must reject.',
  {
    version: 'v1.3',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_A,
    name: 'Fake Collection',
    symbol: 'FAKE',
    uri: 'https://example.com/fake.json',
    sellerFeeBasisPoints: 0,
    creators: null,
    primarySaleHappened: false,
    isMutable: true,
    editionNonce: null,
    tokenStandard: 'NonFungible',
    collection: { verified: false, key: COLLECTION_KEY },
    uses: null,
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_A,
      name: 'Fake Collection',
      symbol: 'FAKE',
      uri: 'https://example.com/fake.json',
      sellerFeeBasisPoints: 0,
      creators: null,
      primarySaleHappened: false,
      isMutable: true,
    });
    // editionNonce = None
    w.u8(0);
    // tokenStandard = Some(NonFungible)
    w.u8(1);
    w.u8(0);
    // collection = Some({ verified:false })
    w.u8(1);
    w.u8(0);
    w.pubkey(COLLECTION_KEY);
    // uses = None
    w.u8(0);
  },
);

// 10. v1.3 Fungible with creators + editionNonce present (odd but valid).
push(
  'v13-fungible-edition-nonce',
  'TokenStandard=Fungible with editionNonce set; exercises the Fungible variant index.',
  {
    version: 'v1.3',
    key: 4,
    updateAuthority: UPDATE_AUTH,
    mint: MINT_C,
    name: 'Fungible Thing',
    symbol: 'FUN',
    uri: 'https://example.com/fun.json',
    sellerFeeBasisPoints: 0,
    creators: [
      { address: CREATOR_1, verified: true, share: 50 },
      { address: CREATOR_2, verified: false, share: 50 },
    ],
    primarySaleHappened: true,
    isMutable: false,
    editionNonce: 100,
    tokenStandard: 'Fungible',
    collection: null,
    uses: null,
    collectionDetails: null,
  },
  (w) => {
    writeHeader(w, {
      updateAuthority: UPDATE_AUTH,
      mint: MINT_C,
      name: 'Fungible Thing',
      symbol: 'FUN',
      uri: 'https://example.com/fun.json',
      sellerFeeBasisPoints: 0,
      creators: [
        { address: CREATOR_1, verified: true, share: 50 },
        { address: CREATOR_2, verified: false, share: 50 },
      ],
      primarySaleHappened: true,
      isMutable: false,
    });
    // editionNonce = Some(100)
    w.u8(1);
    w.u8(100);
    // tokenStandard = Some(Fungible=2)
    w.u8(1);
    w.u8(2);
    // collection = None
    w.u8(0);
    // uses = None
    w.u8(0);
  },
);

// Sanity round-trip of the pubkey strings
for (const pk of [UPDATE_AUTH, MINT_A, MINT_B, MINT_C, CREATOR_1, CREATOR_2, COLLECTION_KEY, PROG_RULESET]) {
  const round = b58encode(b58decode(pk));
  if (round !== pk) throw new Error(`pubkey round-trip mismatch: ${pk}`);
}

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
process.stderr.write(`Generated ${vectors.length} metadata fixtures\n`);

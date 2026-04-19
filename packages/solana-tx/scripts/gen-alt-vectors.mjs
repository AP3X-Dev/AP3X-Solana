// Generate synthetic AddressLookupTable fixtures.
//
// Each fixture is a hand-constructed ALT account laid out per the
// documented 56-byte-header + N*32-byte-addresses format. We emit both the
// raw bytes (base64) and the decoded expectations so the test can
// round-trip without re-implementing the layout.
//
// Run: node packages/solana-tx/scripts/gen-alt-vectors.mjs > packages/solana-tx/tests/fixtures/alt-samples.json

import { Buffer } from 'node:buffer';

// base58 helpers — same as gen-pda-vectors.
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

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * Build an ALT account blob.
 *
 * @param opts.deactivationSlot   bigint
 * @param opts.lastExtendedSlot   bigint
 * @param opts.lastExtendedSlotStartIndex u8
 * @param opts.authority          base58 pubkey string | null
 * @param opts.addresses          array of base58 pubkey strings
 */
function buildAlt(opts) {
  const {
    deactivationSlot,
    lastExtendedSlot,
    lastExtendedSlotStartIndex,
    authority,
    addresses,
  } = opts;
  const headerSize = 56;
  const totalSize = headerSize + addresses.length * 32;
  const out = new Uint8Array(totalSize);
  const dv = new DataView(out.buffer);
  // discriminator u32 LE = 1
  dv.setUint32(0, 1, true);
  // deactivationSlot u64 LE
  dv.setBigUint64(4, deactivationSlot, true);
  // lastExtendedSlot u64 LE
  dv.setBigUint64(12, lastExtendedSlot, true);
  // lastExtendedSlotStartIndex u8
  dv.setUint8(20, lastExtendedSlotStartIndex);
  // authority option tag + pubkey
  if (authority) {
    dv.setUint8(21, 1);
    out.set(b58decode(authority), 22);
  } else {
    dv.setUint8(21, 0);
    // leave 22..53 zeroed
  }
  // padding u16 at offsets 54..55 stays 0
  // addresses
  for (let i = 0; i < addresses.length; i++) {
    out.set(b58decode(addresses[i]), headerSize + i * 32);
  }
  return out;
}

const vectors = [];

function push(label, opts) {
  const bytes = buildAlt(opts);
  vectors.push({
    label,
    dataBase64: Buffer.from(bytes).toString('base64'),
    expected: {
      deactivationSlot: opts.deactivationSlot.toString(),
      lastExtendedSlot: opts.lastExtendedSlot.toString(),
      lastExtendedSlotStartIndex: opts.lastExtendedSlotStartIndex,
      authority: opts.authority,
      addresses: opts.addresses,
    },
  });
}

push('empty', {
  deactivationSlot: 0xffffffffffffffffn,
  lastExtendedSlot: 0n,
  lastExtendedSlotStartIndex: 0,
  authority: SYSTEM_PROGRAM,
  addresses: [],
});

push('single-address', {
  deactivationSlot: 0xffffffffffffffffn,
  lastExtendedSlot: 12345n,
  lastExtendedSlotStartIndex: 0,
  authority: SYSTEM_PROGRAM,
  addresses: [TOKEN_PROGRAM],
});

push('five-common-programs', {
  deactivationSlot: 0xffffffffffffffffn,
  lastExtendedSlot: 200_000_000n,
  lastExtendedSlotStartIndex: 2,
  authority: SYSTEM_PROGRAM,
  addresses: [TOKEN_PROGRAM, ATA_PROGRAM, METAPLEX, WSOL_MINT, USDC_MINT],
});

push('frozen-no-authority', {
  deactivationSlot: 0xffffffffffffffffn,
  lastExtendedSlot: 50n,
  lastExtendedSlotStartIndex: 3,
  authority: null,
  addresses: [TOKEN_PROGRAM, USDC_MINT, USDT_MINT, WSOL_MINT],
});

push('authority-system-program', {
  deactivationSlot: 1_000_000n,
  lastExtendedSlot: 900_000n,
  lastExtendedSlotStartIndex: 4,
  authority: SYSTEM_PROGRAM,
  addresses: [PUMPFUN, TOKEN_PROGRAM, METAPLEX, ATA_PROGRAM, WSOL_MINT, USDC_MINT, USDT_MINT],
});

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
process.stderr.write(`Generated ${vectors.length} ALT vectors\n`);

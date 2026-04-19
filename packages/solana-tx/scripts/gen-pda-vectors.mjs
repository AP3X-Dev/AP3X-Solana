// One-shot script to generate PDA test vectors.
//
// Uses @noble/hashes + @noble/ed25519 directly — the SAME primitives the
// runtime implementation uses. Each vector is self-validated (we derive
// bump+address here, cross-check the address is off-curve, and re-derive
// with the committed bump to confirm round-trip).
//
// Run: node packages/solana-tx/scripts/gen-pda-vectors.mjs > packages/solana-tx/tests/fixtures/pdas.json
//
// Not a build step — the generated JSON is the source of truth committed
// alongside the tests. The script regenerates it from first principles if
// we ever need to widen coverage.

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import * as ed from '@noble/ed25519';

// Wire sha512 for @noble/ed25519 point decompression.
ed.etc.sha512Sync = (...msgs) => sha512(ed.etc.concatBytes(...msgs));
ed.etc.sha512Async = (...msgs) => Promise.resolve(ed.etc.sha512Sync(...msgs));

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

// -- PDA derivation -------------------------------------------------------
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

function isOnCurve(hash) {
  try {
    ed.Point.fromHex(hash);
    return true;
  } catch {
    return false;
  }
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function findProgramAddress(seeds, programIdBytes) {
  for (let bump = 255; bump >= 0; bump--) {
    const pre = concat([...seeds, new Uint8Array([bump]), programIdBytes, PDA_MARKER]);
    const hash = sha256(pre);
    if (!isOnCurve(hash)) {
      return { addressBytes: hash, bump };
    }
  }
  throw new Error('exhausted bumps');
}

// -- Seed helpers ---------------------------------------------------------
function seedFromPubkeyB58(b58) {
  const bytes = b58decode(b58);
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length} for ${b58}`);
  return { type: 'pubkey-base58', value: b58, bytes };
}
function seedFromUtf8(s) {
  return { type: 'utf8', value: s, bytes: new TextEncoder().encode(s) };
}
function seedFromHex(h) {
  if (h.length % 2 !== 0) throw new Error(`hex needs even length: ${h}`);
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return { type: 'hex', value: h, bytes };
}
function seedFromU64LE(n) {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(n), true);
  return { type: 'hex', value: Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(''), bytes: buf };
}

// -- Known program IDs ----------------------------------------------------
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Arbitrary "user" pubkey (JupiterAggregator program, picked for base58 variety)
const SAMPLE_OWNER_A = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
// A random-ish pubkey used as an "owner" in synthetic vectors
const SAMPLE_OWNER_B = 'So11111111111111111111111111111111111111112';

// -- Vector assembly ------------------------------------------------------
const vectors = [];

function pushPda(label, seedDefs, programIdB58) {
  const programIdBytes = b58decode(programIdB58);
  const seedBytesList = seedDefs.map((s) => s.bytes);
  const { addressBytes, bump } = findProgramAddress(seedBytesList, programIdBytes);
  // Re-derive with the stored bump to confirm round-trip.
  const verifyPre = concat([...seedBytesList, new Uint8Array([bump]), programIdBytes, PDA_MARKER]);
  const verifyHash = sha256(verifyPre);
  for (let i = 0; i < 32; i++) {
    if (verifyHash[i] !== addressBytes[i]) {
      throw new Error(`${label}: round-trip mismatch`);
    }
  }
  if (isOnCurve(addressBytes)) {
    throw new Error(`${label}: derived address is on-curve`);
  }
  vectors.push({
    label,
    seeds: seedDefs.map((s) => ({ type: s.type, value: s.value })),
    programId: programIdB58,
    expectedAddress: b58encode(addressBytes),
    expectedBump: bump,
  });
}

// Associated Token Account derivations — seeds = [owner, tokenProgram, mint]
pushPda(
  'ata-sample-owner-a-wsol',
  [seedFromPubkeyB58(SAMPLE_OWNER_A), seedFromPubkeyB58(TOKEN_PROGRAM), seedFromPubkeyB58(WSOL_MINT)],
  ATA_PROGRAM,
);
pushPda(
  'ata-sample-owner-a-usdc',
  [seedFromPubkeyB58(SAMPLE_OWNER_A), seedFromPubkeyB58(TOKEN_PROGRAM), seedFromPubkeyB58(USDC_MINT)],
  ATA_PROGRAM,
);
pushPda(
  'ata-sample-owner-a-usdt',
  [seedFromPubkeyB58(SAMPLE_OWNER_A), seedFromPubkeyB58(TOKEN_PROGRAM), seedFromPubkeyB58(USDT_MINT)],
  ATA_PROGRAM,
);
pushPda(
  'ata-sample-owner-b-wsol',
  [seedFromPubkeyB58(SAMPLE_OWNER_B), seedFromPubkeyB58(TOKEN_PROGRAM), seedFromPubkeyB58(WSOL_MINT)],
  ATA_PROGRAM,
);
pushPda(
  'ata-sample-owner-b-usdc-token2022',
  [seedFromPubkeyB58(SAMPLE_OWNER_B), seedFromPubkeyB58(TOKEN_2022_PROGRAM), seedFromPubkeyB58(USDC_MINT)],
  ATA_PROGRAM,
);
pushPda(
  'ata-system-program-wsol',
  [seedFromPubkeyB58(SYSTEM_PROGRAM), seedFromPubkeyB58(TOKEN_PROGRAM), seedFromPubkeyB58(WSOL_MINT)],
  ATA_PROGRAM,
);

// Metaplex Token Metadata PDAs — seeds = ["metadata", tokenMetadataProgram, mint]
pushPda(
  'metaplex-metadata-wsol',
  [seedFromUtf8('metadata'), seedFromPubkeyB58(METAPLEX), seedFromPubkeyB58(WSOL_MINT)],
  METAPLEX,
);
pushPda(
  'metaplex-metadata-usdc',
  [seedFromUtf8('metadata'), seedFromPubkeyB58(METAPLEX), seedFromPubkeyB58(USDC_MINT)],
  METAPLEX,
);
pushPda(
  'metaplex-master-edition-wsol',
  [seedFromUtf8('metadata'), seedFromPubkeyB58(METAPLEX), seedFromPubkeyB58(WSOL_MINT), seedFromUtf8('edition')],
  METAPLEX,
);
pushPda(
  'metaplex-metadata-pumpfun-sample',
  [seedFromUtf8('metadata'), seedFromPubkeyB58(METAPLEX), seedFromPubkeyB58(PUMPFUN)],
  METAPLEX,
);

// Pump.fun bonding curve PDAs — seeds = ["bonding-curve", mint]
pushPda(
  'pumpfun-bonding-curve-usdc',
  [seedFromUtf8('bonding-curve'), seedFromPubkeyB58(USDC_MINT)],
  PUMPFUN,
);
pushPda(
  'pumpfun-bonding-curve-wsol',
  [seedFromUtf8('bonding-curve'), seedFromPubkeyB58(WSOL_MINT)],
  PUMPFUN,
);
pushPda(
  'pumpfun-bonding-curve-usdt',
  [seedFromUtf8('bonding-curve'), seedFromPubkeyB58(USDT_MINT)],
  PUMPFUN,
);
pushPda(
  'pumpfun-global',
  [seedFromUtf8('global')],
  PUMPFUN,
);
pushPda(
  'pumpfun-fee-recipient',
  [seedFromUtf8('fee_recipient'), seedFromPubkeyB58(PUMPFUN)],
  PUMPFUN,
);

// Simple single-byte / empty-seed vectors for parser edge coverage
pushPda('empty-seed-list', [], SYSTEM_PROGRAM);
pushPda('single-byte-zero', [seedFromHex('00')], SYSTEM_PROGRAM);
pushPda('single-byte-ff', [seedFromHex('ff')], TOKEN_PROGRAM);
pushPda('utf8-user', [seedFromUtf8('user')], ATA_PROGRAM);
pushPda('utf8-user-with-u64', [seedFromUtf8('user'), seedFromU64LE(42n)], PUMPFUN);
pushPda('32-byte-max-seed', [seedFromHex('aa'.repeat(32))], SYSTEM_PROGRAM);

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
process.stderr.write(`Generated ${vectors.length} PDA vectors\n`);

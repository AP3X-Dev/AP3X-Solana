// One-shot generator for ATA canonical-address vectors.
//
// Uses the same PDA algorithm as @noble/hashes + @noble/ed25519 to
// independently derive each expected ATA — NO @solana/* libs. The 10
// committed vectors mix Token-v1 / Token-2022 / system-program owner so the
// solana-spl ATA tests cover all the relevant branches.
//
// Run:
//   node packages/solana-spl/scripts/gen-ata-fixtures.mjs > \
//     packages/solana-spl/tests/fixtures/ata-vectors.json

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import * as ed from '@noble/ed25519';

// Wire sha512 for @noble/ed25519 point decompression.
ed.etc.sha512Sync = (...msgs) => sha512(ed.etc.concatBytes(...msgs));
ed.etc.sha512Async = (...msgs) => Promise.resolve(ed.etc.sha512Sync(...msgs));

// -- base58 --------------------------------------------------------------

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

// -- PDA derivation ------------------------------------------------------

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
    const pre = concat([
      ...seeds,
      new Uint8Array([bump]),
      programIdBytes,
      PDA_MARKER,
    ]);
    const hash = sha256(pre);
    if (!isOnCurve(hash)) {
      return { addressBytes: hash, bump };
    }
  }
  throw new Error('exhausted bumps');
}

// -- Program IDs ---------------------------------------------------------

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
// A couple of mainnet-style owner pubkeys (chosen for base58 variety).
const OWNER_A = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const OWNER_B = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const OWNER_C = '4Nd1mMyUBL4Jv5QrG8v5ntb6NTHDNLtEmKJcYkrv2gUa';

function deriveAta(owner, tokenProgram, mint) {
  const seeds = [
    b58decode(owner),
    b58decode(tokenProgram),
    b58decode(mint),
  ];
  const { addressBytes, bump } = findProgramAddress(seeds, b58decode(ATA_PROGRAM));
  return { address: b58encode(addressBytes), bump };
}

// -- Vectors --------------------------------------------------------------

const vectors = [];

function push(label, owner, mint, tokenProgram = TOKEN_PROGRAM) {
  const { address, bump } = deriveAta(owner, tokenProgram, mint);
  vectors.push({
    label,
    owner,
    mint,
    tokenProgram,
    expectedAddress: address,
    expectedBump: bump,
  });
}

// 1–3: v1 program, three owners paired with wSOL
push('v1-owner-a-wsol', OWNER_A, WSOL_MINT);
push('v1-owner-b-wsol', OWNER_B, WSOL_MINT);
push('v1-owner-c-wsol', OWNER_C, WSOL_MINT);

// 4–5: v1 program, same owner, different mints
push('v1-owner-a-usdc', OWNER_A, USDC_MINT);
push('v1-owner-a-usdt', OWNER_A, USDT_MINT);

// 6–7: Token-2022 owner pairings
push('token2022-owner-b-usdc', OWNER_B, USDC_MINT, TOKEN_2022_PROGRAM);
push('token2022-owner-a-usdt', OWNER_A, USDT_MINT, TOKEN_2022_PROGRAM);

// 8: System-program pubkey as owner (on-curve, used by some protocols)
push('v1-system-owner-wsol', SYSTEM_PROGRAM, WSOL_MINT);

// 9–10: Cross-owner same-mint pairs for ordering sanity
push('v1-owner-c-usdc', OWNER_C, USDC_MINT);
push('v1-owner-b-usdt', OWNER_B, USDT_MINT);

// Sanity — re-derive everything and confirm the bump round-trips.
for (const v of vectors) {
  const seeds = [
    b58decode(v.owner),
    b58decode(v.tokenProgram),
    b58decode(v.mint),
  ];
  const pre = concat([
    ...seeds,
    new Uint8Array([v.expectedBump]),
    b58decode(ATA_PROGRAM),
    PDA_MARKER,
  ]);
  const hash = sha256(pre);
  const addr = b58encode(hash);
  if (addr !== v.expectedAddress) {
    throw new Error(`${v.label}: re-derivation mismatch`);
  }
  if (isOnCurve(hash)) {
    throw new Error(`${v.label}: derived ATA is on-curve`);
  }
}

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
process.stderr.write(`Generated ${vectors.length} ATA vectors\n`);

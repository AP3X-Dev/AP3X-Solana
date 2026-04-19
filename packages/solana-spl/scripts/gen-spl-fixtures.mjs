// One-shot generator for solana-spl TokenMint + TokenAccount fixtures.
//
// Uses only primitive arithmetic + base58 (bitcoin alphabet) — NO
// @solana/* dependencies. Each vector is hand-crafted to exercise a
// specific decoder edge case and committed as the source of truth.
//
// Run:
//   node packages/solana-spl/scripts/gen-spl-fixtures.mjs > \
//     packages/solana-spl/tests/fixtures/spl-accounts-synthetic.json

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

// -- Known program IDs ----------------------------------------------------

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SAMPLE_OWNER_A = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SAMPLE_OWNER_B = 'So11111111111111111111111111111111111111112';
const SAMPLE_AUTHORITY = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SAMPLE_DELEGATE = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const SAMPLE_FREEZE = '11111111111111111111111111111111';
const SAMPLE_CLOSE = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

// -- Writers --------------------------------------------------------------

class W {
  constructor() {
    this.chunks = [];
  }
  u8(v) {
    this.chunks.push(new Uint8Array([v & 0xff]));
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
  // SPL COption<Pubkey>: 4-byte LE tag + 32 bytes.
  // tag=0 → we still write 32 zero bytes so the field occupies its slot.
  coptionPubkey(b58OrNull) {
    if (b58OrNull === null) {
      this.u32(0);
      this.chunks.push(new Uint8Array(32));
    } else {
      this.u32(1);
      this.pubkey(b58OrNull);
    }
  }
  // SPL COption<u64>: 4-byte LE tag + 8-byte u64.
  // tag=0 → we still write 8 zero bytes.
  coptionU64(valueOrNull) {
    if (valueOrNull === null) {
      this.u32(0);
      this.u64(0n);
    } else {
      this.u32(1);
      this.u64(valueOrNull);
    }
  }
  bytes(arr) {
    this.chunks.push(arr);
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

// -- Builders -------------------------------------------------------------

function buildMint({
  mintAuthority,
  supply,
  decimals,
  isInitialized,
  freezeAuthority,
}) {
  const w = new W();
  w.coptionPubkey(mintAuthority);
  w.u64(supply);
  w.u8(decimals);
  w.u8(isInitialized ? 1 : 0);
  w.coptionPubkey(freezeAuthority);
  const bytes = w.build();
  if (bytes.length !== 82)
    throw new Error(`mint fixture wrong length: ${bytes.length}`);
  return bytes;
}

function buildTokenAccount({
  mint,
  owner,
  amount,
  delegate,
  state, // 0|1|2
  isNative, // bigint|null
  delegatedAmount,
  closeAuthority,
}) {
  const w = new W();
  w.pubkey(mint);
  w.pubkey(owner);
  w.u64(amount);
  w.coptionPubkey(delegate);
  w.u8(state);
  w.coptionU64(isNative);
  w.u64(delegatedAmount);
  w.coptionPubkey(closeAuthority);
  const bytes = w.build();
  if (bytes.length !== 165)
    throw new Error(`account fixture wrong length: ${bytes.length}`);
  return bytes;
}

// -- Vectors --------------------------------------------------------------

const vectors = [];

function pushMint(label, spec, { tokenProgram = 'spl-v1' } = {}) {
  const bytes = buildMint(spec);
  vectors.push({
    kind: 'mint',
    label,
    owner: tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    tokenProgram,
    dataBase64: Buffer.from(bytes).toString('base64'),
    expected: {
      mintAuthority: spec.mintAuthority,
      supply: spec.supply.toString(),
      decimals: spec.decimals,
      isInitialized: spec.isInitialized,
      freezeAuthority: spec.freezeAuthority,
      tokenProgram,
    },
  });
}

function pushAccount(label, spec, { tokenProgram = 'spl-v1' } = {}) {
  const bytes = buildTokenAccount(spec);
  const stateStr =
    spec.state === 0
      ? 'uninitialized'
      : spec.state === 1
        ? 'initialized'
        : 'frozen';
  vectors.push({
    kind: 'account',
    label,
    owner: tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    tokenProgram,
    dataBase64: Buffer.from(bytes).toString('base64'),
    expected: {
      mint: spec.mint,
      owner: spec.owner,
      amount: spec.amount.toString(),
      delegate: spec.delegate,
      state: stateStr,
      isNative: spec.isNative === null ? null : spec.isNative.toString(),
      delegatedAmount: spec.delegatedAmount.toString(),
      closeAuthority: spec.closeAuthority,
      tokenProgram,
    },
  });
}

// 1. Standard mint — authorities present
pushMint('mint-standard', {
  mintAuthority: SAMPLE_AUTHORITY,
  supply: 1_000_000_000n,
  decimals: 6,
  isInitialized: true,
  freezeAuthority: SAMPLE_FREEZE,
});

// 2. Mint with revoked mintAuthority (COption tag=0)
pushMint('mint-revoked-mint-authority', {
  mintAuthority: null,
  supply: 500_000_000n,
  decimals: 9,
  isInitialized: true,
  freezeAuthority: SAMPLE_FREEZE,
});

// 3. Mint with revoked freezeAuthority
pushMint('mint-revoked-freeze-authority', {
  mintAuthority: SAMPLE_AUTHORITY,
  supply: 123_456_789n,
  decimals: 2,
  isInitialized: true,
  freezeAuthority: null,
});

// 4. Token-2022 mint (owner = TOKEN_2022_PROGRAM_ID)
pushMint(
  'mint-token-2022',
  {
    mintAuthority: SAMPLE_AUTHORITY,
    supply: 10_000n,
    decimals: 0,
    isInitialized: true,
    freezeAuthority: null,
  },
  { tokenProgram: 'token-2022' },
);

// 5. Standard token account — initialised, delegated
pushAccount('account-standard-initialized-delegated', {
  mint: USDC_MINT,
  owner: SAMPLE_OWNER_A,
  amount: 42_000_000n,
  delegate: SAMPLE_DELEGATE,
  state: 1,
  isNative: null,
  delegatedAmount: 10_000_000n,
  closeAuthority: null,
});

// 6. Frozen token account
pushAccount('account-frozen', {
  mint: USDC_MINT,
  owner: SAMPLE_OWNER_A,
  amount: 0n,
  delegate: null,
  state: 2,
  isNative: null,
  delegatedAmount: 0n,
  closeAuthority: null,
});

// 7. Native wSOL token account — isNative carries the rent-exempt reserve
pushAccount('account-native-wsol', {
  mint: WSOL_MINT,
  owner: SAMPLE_OWNER_B,
  amount: 5_000_000_000n,
  delegate: null,
  state: 1,
  isNative: 2_039_280n, // typical rent-exempt reserve for 165-byte accounts
  delegatedAmount: 0n,
  closeAuthority: null,
});

// 8. Uninitialized token account
pushAccount('account-uninitialized', {
  mint: USDT_MINT,
  owner: SAMPLE_OWNER_B,
  amount: 0n,
  delegate: null,
  state: 0,
  isNative: null,
  delegatedAmount: 0n,
  closeAuthority: null,
});

// 9. Token account with BOTH delegate AND delegatedAmount
pushAccount('account-delegated-with-amount', {
  mint: USDT_MINT,
  owner: SAMPLE_OWNER_A,
  amount: 999_999_999n,
  delegate: SAMPLE_DELEGATE,
  state: 1,
  isNative: null,
  delegatedAmount: 999_999_999n,
  closeAuthority: null,
});

// 10. Token account with close authority set
pushAccount('account-with-close-authority', {
  mint: USDC_MINT,
  owner: SAMPLE_OWNER_A,
  amount: 1n,
  delegate: null,
  state: 1,
  isNative: null,
  delegatedAmount: 0n,
  closeAuthority: SAMPLE_CLOSE,
});

// Sanity: base58 round-trip every pubkey we referenced.
for (const pk of [
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT,
  SAMPLE_OWNER_A,
  SAMPLE_OWNER_B,
  SAMPLE_AUTHORITY,
  SAMPLE_DELEGATE,
  SAMPLE_FREEZE,
  SAMPLE_CLOSE,
]) {
  const round = b58encode(b58decode(pk));
  if (round !== pk) throw new Error(`pubkey round-trip mismatch: ${pk}`);
}

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
process.stderr.write(`Generated ${vectors.length} SPL fixtures\n`);

// One-shot script to generate base58 test vectors.
// Uses a pure bigint bs58 reference implementation (not imported from npm) and
// cross-checks decode(encode(bytes)) === bytes for every vector.
// Run: node scripts/gen-base58-vectors.mjs > packages/solana-core/tests/fixtures/base58-vectors.json
// Not committed as a build step; the generated JSON is the source of truth.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) MAP[ALPHABET.charCodeAt(i)] = i;

function encode(bytes) {
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

function decode(str) {
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

function b58ToBytes(s) {
  return Array.from(decode(s));
}

const vectors = [];

function push(label, bytesArr) {
  const bytes = Uint8Array.from(bytesArr);
  const encoded = encode(bytes);
  // Round-trip check
  const back = decode(encoded);
  if (back.length !== bytes.length) throw new Error(`len mismatch: ${label}`);
  for (let i = 0; i < bytes.length; i++) {
    if (back[i] !== bytes[i]) throw new Error(`byte mismatch: ${label}`);
  }
  vectors.push({ label, bytes: Array.from(bytes), encoded });
}

function pushKnown(label, encoded) {
  // Given a known base58 string, derive the bytes via reference decode.
  const bytes = decode(encoded);
  // Double-check round trip
  const reenc = encode(bytes);
  if (reenc !== encoded) throw new Error(`round-trip mismatch for ${label}: ${reenc} !== ${encoded}`);
  vectors.push({ label, bytes: Array.from(bytes), encoded });
}

// Edge cases
push('empty', []);
push('single-zero', [0x00]);
push('single-one', [0x01]);
push('single-ff', [0xff]);
push('two-zeros', [0x00, 0x00]);
push('two-ff', [0xff, 0xff]);
push('zero-then-ff', [0x00, 0xff]);
push('ff-then-zero', [0xff, 0x00]);
push('three-zeros', [0x00, 0x00, 0x00]);
push('four-zeros', [0x00, 0x00, 0x00, 0x00]);
push('bitcoin-hello', [0x68, 0x65, 0x6c, 0x6c, 0x6f]); // 'hello'
push('bitcoin-00-hello', [0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f]); // '11' + hello
push('ascii-abc', [0x61, 0x62, 0x63]);
push('seq-0-15', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

// 32-byte pubkeys, all zero / all ones / alternating patterns
push('pubkey-32-zero', new Array(32).fill(0));
push('pubkey-32-ff', new Array(32).fill(0xff));
push('pubkey-32-alt-55', new Array(32).fill(0x55));
push('pubkey-32-alt-aa', new Array(32).fill(0xaa));
{
  const a = new Array(32);
  for (let i = 0; i < 32; i++) a[i] = i;
  push('pubkey-32-seq', a);
}
{
  const a = new Array(32);
  for (let i = 0; i < 32; i++) a[i] = 31 - i;
  push('pubkey-32-rev', a);
}
// Leading-zero 32-byte key
{
  const a = new Array(32).fill(0);
  a[31] = 0x01;
  push('pubkey-32-leading-zeros-low-one', a);
}
{
  const a = new Array(32).fill(0);
  a[0] = 0xff;
  push('pubkey-32-high-ff-rest-zero', a);
}

// Known Solana program IDs — use decode() to derive bytes
pushKnown('system-program', '11111111111111111111111111111111');
pushKnown('token-program', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
pushKnown('token-2022-program', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
pushKnown('ata-program', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
pushKnown('metaplex-token-metadata', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
pushKnown('compute-budget', 'ComputeBudget111111111111111111111111111111');
pushKnown('stake-program', 'Stake11111111111111111111111111111111111111');
pushKnown('vote-program', 'Vote111111111111111111111111111111111111111');
pushKnown('bpf-loader-upgradeable', 'BPFLoaderUpgradeab1e11111111111111111111111');
pushKnown('sysvar-rent', 'SysvarRent111111111111111111111111111111111');
pushKnown('sysvar-clock', 'SysvarC1ock11111111111111111111111111111111');
pushKnown('sysvar-rewards', 'SysvarRewards111111111111111111111111111111');
pushKnown('native-sol-mint', 'So11111111111111111111111111111111111111112');
pushKnown('usdc-mint', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
pushKnown('usdt-mint', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
pushKnown('jito-tip-distribution', '4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7');
pushKnown('pumpfun-program', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Varying byte lengths to exercise the big-int path
push('len-6-incr', [1, 2, 3, 4, 5, 6]);
push('len-8-high', [0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88]);
push('len-16-mix', [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
push('len-20-leading-zeros', [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

// 64-byte deterministic "signature-shaped" buffers
{
  const a = new Array(64);
  for (let i = 0; i < 64; i++) a[i] = (i * 7 + 13) & 0xff;
  push('signature-64-lcg', a);
}
{
  const a = new Array(64).fill(0);
  push('signature-64-zero', a);
}
{
  const a = new Array(64).fill(0xff);
  push('signature-64-ff', a);
}
{
  const a = new Array(64);
  for (let i = 0; i < 64; i++) a[i] = i;
  push('signature-64-seq', a);
}
{
  const a = new Array(64);
  for (let i = 0; i < 64; i++) a[i] = 63 - i;
  push('signature-64-rev', a);
}
// Signature with significant leading zeros
{
  const a = new Array(64).fill(0);
  for (let i = 10; i < 64; i++) a[i] = ((i * 31) ^ 0x5a) & 0xff;
  push('signature-64-leading-10-zeros', a);
}

// Known bs58 reference vectors (from the bitcoin-core / bs58 test suite)
// Commented reference (each decode(encoded) yields the left-hand bytes):
// hex -> base58
// ""               -> ""
// "61"             -> "2g"
// "626262"         -> "a3gV"
// "636363"         -> "aPEr"
// "73696d706c792061206c6f6e6720737472696e67" -> "2cFupjhnEsSn59qHXstmK2ffpLv2"
// "00eb15231dfceb60925886b67d065299925915aeb172c06647" -> "1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L"
// "516b6fcd0f"     -> "ABnLTmg"
// "bf4f89001e670274dd" -> "3SEo3LWLoPntC"
// "572e4794"       -> "3EFU7m"
// "ecac89cad93923c02321" -> "EJDM8drfXA6uyA"
// "10c8511e"       -> "Rt5zm"
// "00000000000000000000" -> "1111111111"

push('bs58-ref-61', [0x61]);
push('bs58-ref-626262', [0x62, 0x62, 0x62]);
push('bs58-ref-636363', [0x63, 0x63, 0x63]);
push('bs58-ref-simply-a-long-string', [0x73, 0x69, 0x6d, 0x70, 0x6c, 0x79, 0x20, 0x61, 0x20, 0x6c, 0x6f, 0x6e, 0x67, 0x20, 0x73, 0x74, 0x72, 0x69, 0x6e, 0x67]);
push('bs58-ref-516b6fcd0f', [0x51, 0x6b, 0x6f, 0xcd, 0x0f]);
push('bs58-ref-bf4f89001e670274dd', [0xbf, 0x4f, 0x89, 0x00, 0x1e, 0x67, 0x02, 0x74, 0xdd]);
push('bs58-ref-572e4794', [0x57, 0x2e, 0x47, 0x94]);
push('bs58-ref-ecac89cad93923c02321', [0xec, 0xac, 0x89, 0xca, 0xd9, 0x39, 0x23, 0xc0, 0x23, 0x21]);
push('bs58-ref-10c8511e', [0x10, 0xc8, 0x51, 0x1e]);
push('bs58-ref-ten-zeros', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

// Cross-check known bs58 reference outputs
const EXPECTED = {
  'bs58-ref-61': '2g',
  'bs58-ref-626262': 'a3gV',
  'bs58-ref-636363': 'aPEr',
  'bs58-ref-simply-a-long-string': '2cFupjhnEsSn59qHXstmK2ffpLv2',
  'bs58-ref-516b6fcd0f': 'ABnLTmg',
  'bs58-ref-bf4f89001e670274dd': '3SEo3LWLoPntC',
  'bs58-ref-572e4794': '3EFU7m',
  'bs58-ref-ecac89cad93923c02321': 'EJDM8drfXA6uyA',
  'bs58-ref-10c8511e': 'Rt5zm',
  'bs58-ref-ten-zeros': '1111111111',
  'single-zero': '1',
  'single-ff': '5Q',
  'system-program': '11111111111111111111111111111111',
};
for (const [label, expected] of Object.entries(EXPECTED)) {
  const v = vectors.find((x) => x.label === label);
  if (!v) throw new Error(`missing vector: ${label}`);
  if (v.encoded !== expected) {
    throw new Error(`encoded mismatch for ${label}: got "${v.encoded}", expected "${expected}"`);
  }
}

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n');
process.stderr.write(`Generated ${vectors.length} vectors\n`);

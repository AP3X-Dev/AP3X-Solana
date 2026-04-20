/**
 * generate-fixture.ts
 *
 * Produces `tests/fixtures/signals-spl-watcher.jsonl.gz` — 50 deterministic
 * SPL transfer signals for use by the spl-watcher example's e2e test (T47).
 *
 * Distribution (for T47's `--wallet 11111111111111111111111111111112` probe):
 *   Signals 0–9  (10 signals): dest = WATCHED_WALLET (hit)
 *   Signals 10–49 (40 signals): dest = various other wallets (miss)
 *
 * Determinism guarantees:
 *   - No Date.now(), Math.random(), or process.hrtime()
 *   - Signatures derived from sha256(`fixture-${i}`) → base58
 *   - signalId() derived from signature + programId + kind + logIndex
 *   - Slots are base 200_000_000, monotonically increasing by 1
 *   - ts is a fixed epoch (1_700_000_000_000 + i * 400)
 *   - Amounts are fixed small u64 values well within Number.MAX_SAFE_INTEGER
 *
 * Re-running this script should always produce byte-identical output given the
 * same dependency versions.
 *
 * Run: pnpm --filter spl-watcher generate-fixture
 */

import { createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, base58 } from '@ap3x/solana-core';
import { SPL_TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import { signalId } from '@ap3x/solana-signals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve output path relative to repo root (two levels above examples/spl-watcher)
const OUTPUT = resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'signals-spl-watcher.jsonl.gz');

/**
 * The "watched" destination wallet used by T47's e2e probe.
 * Signals 0–9 target this address so `--wallet <WATCHED_WALLET>` yields 10 hits.
 */
const WATCHED_WALLET = '11111111111111111111111111111112';

// A handful of "other" destination wallets for the unwatched signals.
const OTHER_WALLETS = [
  'So11111111111111111111111111111111111111112',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
];

// A handful of "source" wallet addresses.
const SOURCE_WALLETS = [
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
];

const SPL_PROGRAM_ID_B58 = SPL_TOKEN_PROGRAM_ID.toBase58();
const BASE_SLOT = 200_000_000;
const BASE_TS = 1_700_000_000_000;
const TOTAL = 50;
const WATCHED_COUNT = 10;

/**
 * Derive a deterministic 64-byte (base58-encoded) fake signature from an index.
 * sha256 produces 32 bytes; we double it to hit the typical 88-char length of
 * real Solana signatures (which are 64-byte ed25519 sigs).
 */
function deterministicSignature(i: number): string {
  const enc = new TextEncoder();
  const a = sha256(enc.encode(`fixture-${i}-a`));
  const b = sha256(enc.encode(`fixture-${i}-b`));
  const combined = new Uint8Array(64);
  combined.set(a, 0);
  combined.set(b, 32);
  return base58.encode(combined);
}

function buildSignal(i: number): object {
  const sig = deterministicSignature(i);
  const slot = BASE_SLOT + i;
  const ts = BASE_TS + i * 400;

  const sourceAddr = SOURCE_WALLETS[i % SOURCE_WALLETS.length]!;
  const destAddr =
    i < WATCHED_COUNT
      ? WATCHED_WALLET
      : OTHER_WALLETS[(i - WATCHED_COUNT) % OTHER_WALLETS.length]!;

  // Validate public keys parse cleanly (catches typos in constant tables).
  const source = PublicKey.fromBase58(sourceAddr);
  const dest = PublicKey.fromBase58(destAddr);

  // Amount: a small deterministic u64 that fits in Number.MAX_SAFE_INTEGER.
  // Strategy code in T46 will read `decoded.amount` as a number and do
  // BigInt(decoded.amount) when needed.
  const amount = 1_000_000 + i * 7_777;

  const id = signalId({
    signature: sig,
    programId: SPL_TOKEN_PROGRAM_ID,
    kind: 'spl.transfer',
    logIndex: 0,
  });

  // ProgramLogChunk — stored with programId as string (base58).
  // FixtureSignalSource.parseSignal will leave it as string (raw.programId
  // check in parseSignal converts string → PublicKey only on load).
  const raw = {
    programId: SPL_PROGRAM_ID_B58,
    depth: 1,
    success: true,
    logs: [`Program log: Instruction: Transfer`],
    dataPayloads: [],
    children: [],
    rawLines: [
      `Program ${SPL_PROGRAM_ID_B58} invoke [1]`,
      `Program log: Instruction: Transfer`,
      `Program ${SPL_PROGRAM_ID_B58} success`,
    ],
  };

  return {
    signalId: id,
    ts,
    slot,
    signature: sig,
    // programId stored as base58 string; FixtureSignalSource.parseSignal
    // will hydrate it to PublicKey on load.
    programId: SPL_PROGRAM_ID_B58,
    kind: 'spl.transfer',
    decoded: {
      source: source.toBase58(),
      dest: dest.toBase58(),
      amount,
    },
    raw,
  };
}

async function main(): Promise<void> {
  const gz = zlib.createGzip({ level: 9 });
  const out = createWriteStream(OUTPUT);
  gz.pipe(out);

  for (let i = 0; i < TOTAL; i++) {
    const signal = buildSignal(i);
    gz.write(JSON.stringify(signal) + '\n');
  }

  gz.end();
  await new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    out.on('error', reject);
  });

  console.log(`Written ${TOTAL} signals (${WATCHED_COUNT} targeting ${WATCHED_WALLET}) → ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * generate-fixture.ts
 *
 * Produces `tests/fixtures/signals-pumpfun-watch.jsonl.gz` — a deterministic,
 * hand-crafted fixture covering every pump.fun event variant used by the
 * example's e2e test.
 *
 * Distribution (20 signals total):
 *   Bonding curve variants (10): create, trade×4, complete, set_params,
 *                                creator_fee, migrate, unknown
 *   PumpSwap variants      (10): swap×5, add_liquidity, remove_liquidity,
 *                                admin_set_params, unknown×2
 *
 * Determinism guarantees:
 *   - No Date.now(), Math.random(), or process.hrtime()
 *   - Signatures derived from sha256(`pumpfun-fixture-${i}`) → base58
 *   - signalId() derived from signature + programId + kind + logIndex
 *   - Slots are base 210_000_000, monotonically increasing by 1
 *   - ts is a fixed epoch (1_700_000_000_000 + i * 400)
 *   - Bigint fields serialised as decimal strings (JSON has no bigint)
 *
 * Re-running should produce byte-identical output under the same deps.
 *
 * Run: pnpm --filter @ap3x/pumpfun-watch generate-fixture
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, base58 } from '@ap3x/solana-core';
import { signalId } from '@ap3x/solana-signals';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT = resolve(__dirname, '..', 'tests', 'fixtures', 'signals-pumpfun-watch.jsonl.gz');

const BC_ID = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
const PS_ID = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();

const BASE_SLOT = 210_000_000;
const BASE_TS = 1_700_000_000_000;

// Pre-computed deterministic pubkeys — derived via sha256 so they parse cleanly
// as valid ed25519-shaped 32-byte base58 addresses. We don't need them to be
// on-curve; PublicKey.fromBase58 accepts any 32-byte value.
function detPubkey(tag: string): PublicKey {
  const h = sha256(new TextEncoder().encode(`pumpfun-fixture-pk-${tag}`));
  return PublicKey.fromBytes(h);
}

const MINT_A = detPubkey('mint-a');
const MINT_B = detPubkey('mint-b');
const USER_A = detPubkey('user-a');
const USER_B = detPubkey('user-b');
const CREATOR = detPubkey('creator');
const BONDING_CURVE_A = detPubkey('bc-a');
const POOL_A = detPubkey('pool-a');
const FEE_RECIPIENT = detPubkey('fee-recipient');
const AUTHORITY = detPubkey('authority');
const SOL_MINT = PublicKey.fromBase58('So11111111111111111111111111111111111111112');

function detSignature(i: number): string {
  const enc = new TextEncoder();
  const a = sha256(enc.encode(`pumpfun-fixture-${i}-a`));
  const b = sha256(enc.encode(`pumpfun-fixture-${i}-b`));
  const combined = new Uint8Array(64);
  combined.set(a, 0);
  combined.set(b, 32);
  return base58.encode(combined);
}

/**
 * Build one signal record. The `decoded` field is emitted as already-decoded
 * JSON-safe primitives so the FixtureSignalSource passes it through untouched.
 * Bigints are stringified (JSON has no bigint); the WatcherStrategy's
 * `serialise()` helper is also a no-op on strings so the e2e output is stable.
 */
function buildSignal(
  i: number,
  programIdStr: string,
  kind: string,
  decoded: Record<string, unknown>,
): object {
  const sig = detSignature(i);
  const slot = BASE_SLOT + i;
  const ts = BASE_TS + i * 400;
  const programId = PublicKey.fromBase58(programIdStr);

  const id = signalId({ signature: sig, programId, kind, logIndex: 0 });

  const raw = {
    programId: programIdStr,
    depth: 1,
    success: true,
    logs: [`Program log: ${kind}`],
    dataPayloads: [],
    children: [],
    rawLines: [
      `Program ${programIdStr} invoke [1]`,
      `Program log: ${kind}`,
      `Program ${programIdStr} success`,
    ],
  };

  return {
    signalId: id,
    ts,
    slot,
    signature: sig,
    programId: programIdStr,
    kind,
    decoded,
    raw,
  };
}

/** Coerce a pubkey-or-string into base58 string for fixture JSON. */
function b58(pk: PublicKey | string): string {
  return typeof pk === 'string' ? pk : pk.toBase58();
}

/** Bigint → decimal string. */
function bi(n: bigint): string {
  return n.toString();
}

function records(): object[] {
  const out: object[] = [];
  let i = 0;

  // --- Bonding curve events (10) ---

  out.push(buildSignal(i++, BC_ID, 'pumpfun.create', {
    mint: b58(MINT_A),
    name: 'Fixture Token A',
    symbol: 'FIXA',
    uri: 'https://example.invalid/fixa.json',
    creator: b58(CREATOR),
    bondingCurve: b58(BONDING_CURVE_A),
    initialVirtualSolReserves: bi(30_000_000_000n),
    initialVirtualTokenReserves: bi(1_073_000_000_000_000n),
    timestamp: bi(1_700_000_100n),
  }));

  for (let t = 0; t < 4; t++) {
    out.push(buildSignal(i++, BC_ID, 'pumpfun.trade', {
      mint: b58(MINT_A),
      solAmount: bi(100_000_000n * BigInt(t + 1)),
      tokenAmount: bi(5_000_000_000n * BigInt(t + 1)),
      isBuy: t % 2 === 0,
      user: b58(t % 2 === 0 ? USER_A : USER_B),
      timestamp: bi(1_700_000_200n + BigInt(t)),
      virtualSolReserves: bi(30_000_000_000n + BigInt(t) * 100_000_000n),
      virtualTokenReserves: bi(1_073_000_000_000_000n - BigInt(t) * 5_000_000_000n),
      realSolReserves: bi(BigInt(t) * 100_000_000n),
      realTokenReserves: bi(BigInt(t) * 5_000_000_000n),
    }));
  }

  out.push(buildSignal(i++, BC_ID, 'pumpfun.complete', {
    mint: b58(MINT_A),
    user: b58(USER_A),
    bondingCurve: b58(BONDING_CURVE_A),
    timestamp: bi(1_700_000_300n),
  }));

  out.push(buildSignal(i++, BC_ID, 'pumpfun.set_params', {
    feeRecipient: b58(FEE_RECIPIENT),
    initialVirtualTokenReserves: bi(1_073_000_000_000_000n),
    initialVirtualSolReserves: bi(30_000_000_000n),
    initialRealTokenReserves: bi(793_100_000_000_000n),
    tokenTotalSupply: bi(1_000_000_000_000_000n),
    feeBasisPoints: 100,
  }));

  out.push(buildSignal(i++, BC_ID, 'pumpfun.creator_fee', {
    mint: b58(MINT_A),
    creator: b58(CREATOR),
    solAmount: bi(50_000_000n),
    timestamp: bi(1_700_000_400n),
  }));

  out.push(buildSignal(i++, BC_ID, 'pumpfun.migrate', {
    mint: b58(MINT_A),
    bondingCurve: b58(BONDING_CURVE_A),
    pool: b58(POOL_A),
    timestamp: bi(1_700_000_500n),
  }));

  out.push(buildSignal(i++, BC_ID, 'unknown', {
    kind: 'unknown',
    programId: BC_ID,
    reason: 'unrecognised-discriminator',
  }));

  // --- PumpSwap events (10) ---

  for (let s = 0; s < 5; s++) {
    out.push(buildSignal(i++, PS_ID, 'pumpfun.swap', {
      pool: b58(POOL_A),
      user: b58(s % 2 === 0 ? USER_A : USER_B),
      inputMint: b58(s % 2 === 0 ? SOL_MINT : MINT_A),
      outputMint: b58(s % 2 === 0 ? MINT_A : SOL_MINT),
      inputAmount: bi(10_000_000n * BigInt(s + 1)),
      outputAmount: bi(500_000_000n * BigInt(s + 1)),
      poolBaseReserves: bi(100_000_000_000n + BigInt(s) * 10_000_000n),
      poolQuoteReserves: bi(5_000_000_000n + BigInt(s) * 500_000n),
      timestamp: bi(1_700_001_000n + BigInt(s)),
    }));
  }

  out.push(buildSignal(i++, PS_ID, 'pumpfun.add_liquidity', {
    pool: b58(POOL_A),
    user: b58(USER_A),
    baseAmount: bi(1_000_000_000n),
    quoteAmount: bi(500_000_000n),
    lpTokens: bi(707_106_781n),
    timestamp: bi(1_700_002_000n),
  }));

  out.push(buildSignal(i++, PS_ID, 'pumpfun.remove_liquidity', {
    pool: b58(POOL_A),
    user: b58(USER_B),
    baseAmount: bi(500_000_000n),
    quoteAmount: bi(250_000_000n),
    lpTokens: bi(353_553_390n),
    timestamp: bi(1_700_002_100n),
  }));

  out.push(buildSignal(i++, PS_ID, 'pumpfun.admin_set_params', {
    authority: b58(AUTHORITY),
    newFeeBasisPoints: 30,
    timestamp: bi(1_700_002_200n),
  }));

  out.push(buildSignal(i++, PS_ID, 'unknown', {
    kind: 'unknown',
    programId: PS_ID,
    reason: 'unrecognised-discriminator',
  }));

  out.push(buildSignal(i++, PS_ID, 'unknown', {
    kind: 'unknown',
    programId: PS_ID,
    reason: 'borsh-parse-error:swap:short-read',
  }));

  return out;
}

async function main(): Promise<void> {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  const gz = zlib.createGzip({ level: 9 });
  const out = createWriteStream(OUTPUT);
  gz.pipe(out);

  const signals = records();
  for (const s of signals) {
    gz.write(JSON.stringify(s) + '\n');
  }

  gz.end();
  await new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    out.on('error', reject);
  });

  console.log(`Written ${signals.length} signals → ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

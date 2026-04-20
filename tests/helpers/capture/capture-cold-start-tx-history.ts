/* eslint-disable */
/**
 * Captures the per-tx signature history needed for gate-8 cost-basis
 * reconstruction. Selects 10 wallets from the existing
 * `tests/fixtures/spl-accounts.json.gz` snapshot (PRP-01 commit 80eb783) with
 * non-trivial trade history, then for each wallet pages
 * getSignaturesForAddress (90d lookback) and getTransaction for every
 * signature, gz-compressing the result as JSONL.
 *
 * Run once with RPC_URL set to a Helius free-tier endpoint:
 *   RPC_URL=https://mainnet.helius-rpc.com/?api-key=... pnpm capture:cold-start-tx-history
 *
 * Output:
 *   tests/fixtures/portfolio-cold-start-wallets.json   — selected wallet list
 *   tests/fixtures/cold-start-tx-history.jsonl.gz      — per-tx history (JSONL, gzipped)
 *
 * Shape of cold-start-tx-history.jsonl.gz (one JSON object per line):
 *   {
 *     wallet: string,     // base58 owner pubkey
 *     mint: string,       // base58 mint pubkey (first mint seen for this owner)
 *     signature: string,  // transaction signature
 *     slot: number,
 *     tx: object,         // raw getTransaction result
 *   }
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { RpcPool, type RpcEndpoint } from '@ap3x/solana-connectivity';

const FIXTURE_ROOT = path.resolve('tests/fixtures');
const SOURCE = path.join(FIXTURE_ROOT, 'spl-accounts.json.gz');
const SELECTION_OUT = path.join(FIXTURE_ROOT, 'portfolio-cold-start-wallets.json');
const HISTORY_OUT = path.join(FIXTURE_ROOT, 'cold-start-tx-history.jsonl.gz');
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const TARGET_WALLETS = 10;
const MIN_SIGS_PER_WALLET = 3;

// ---------------------------------------------------------------------------
// SPL fixture shape (written by spl-capture.ts)
// ---------------------------------------------------------------------------

interface SplFixture {
  capturedAt: string;
  rpcEndpoint: string;
  mintCount: number;
  tokenAccountCount: number;
  mints: unknown[];
  tokenAccounts: Array<{
    pubkey: string;
    dataBase64: string;
    decoded: {
      mint: string;
      owner: string;
      amount: string; // bigint serialised as string by jsonReplacer
      state: string;
    };
  }>;
}

interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = '';
    u.pathname = u.pathname.replace(/\/[A-Za-z0-9_-]{16,}\/?$/, '/<redacted>');
    return u.toString();
  } catch {
    return '<malformed RPC_URL>';
  }
}

async function readSplFixture(p: string): Promise<SplFixture> {
  if (!existsSync(p)) {
    throw new Error(
      `SPL fixture not found: ${p}\n` +
        'Run `pnpm capture:spl` first to create the fixture.',
    );
  }
  const gzBuf = await readFile(p);
  const json = await new Promise<string>((resolve, reject) => {
    zlib.gunzip(gzBuf, (err, buf) => {
      if (err) reject(err);
      else resolve(buf.toString('utf8'));
    });
  });
  return JSON.parse(json) as SplFixture;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rpcUrl = process.env['RPC_URL'];
  if (!rpcUrl) {
    console.error(
      'RPC_URL env var required.\n' +
        'Usage: RPC_URL=https://mainnet.helius-rpc.com/?api-key=... pnpm capture:cold-start-tx-history',
    );
    process.exit(2);
  }

  const endpoint: RpcEndpoint = {
    name: 'custom',
    url: rpcUrl,
    kind: 'http',
  };
  const pool = new RpcPool({
    endpoints: [endpoint],
    timeoutMs: 60_000,
    retry: { attempts: 3, backoffMs: 500, jitter: 0.2 },
  });

  // Step 1 — load the SPL fixture and collect unique owner → mint mappings.
  console.error(`Reading SPL fixture: ${SOURCE}`);
  const fixture = await readSplFixture(SOURCE);
  console.error(
    `  loaded ${fixture.tokenAccounts.length} token accounts from ${fixture.capturedAt}`,
  );

  const ownerToMint = new Map<string, string>();
  for (const ta of fixture.tokenAccounts) {
    const { owner, mint, amount, state } = ta.decoded;
    // Skip zero-balance or non-initialised accounts — they have no trade history.
    if (amount === '0' || state !== 'initialized') continue;
    if (ownerToMint.has(owner)) continue;
    ownerToMint.set(owner, mint);
    // Gather plenty of candidates; we'll filter by actual sig count below.
    if (ownerToMint.size >= TARGET_WALLETS * 5) break;
  }
  console.error(`  ${ownerToMint.size} candidate owners with non-zero initialised balances`);

  // Step 2 — page getSignaturesForAddress for each candidate and keep the
  // wallets with enough recent (90d) signatures.
  const sinceSec = (Date.now() - LOOKBACK_MS) / 1000;
  const candidates: Array<{ wallet: string; mint: string; sigCount: number }> = [];

  for (const [wallet, mint] of ownerToMint) {
    if (candidates.length >= TARGET_WALLETS) break;
    console.error(`  probing ${wallet}...`);
    let sigs: SignatureInfo[];
    try {
      sigs = (await pool.call('getSignaturesForAddress', [wallet, { limit: 1000 }])) as SignatureInfo[];
    } catch (err) {
      console.error(`    failed: ${(err as Error).message} — skipping`);
      continue;
    }
    const inWindow = sigs.filter(
      (s) => s.blockTime !== null && s.blockTime >= sinceSec,
    );
    console.error(`    ${inWindow.length} sigs in 90d window`);
    if (inWindow.length < MIN_SIGS_PER_WALLET) continue;
    candidates.push({ wallet, mint, sigCount: inWindow.length });
  }

  if (candidates.length < TARGET_WALLETS) {
    throw new Error(
      `Only ${candidates.length} qualifying wallets found (need ${TARGET_WALLETS}). ` +
        'Try a node with more indexing depth, or lower MIN_SIGS_PER_WALLET.',
    );
  }

  await writeFile(
    SELECTION_OUT,
    JSON.stringify({ capturedAt: new Date().toISOString(), rpcEndpoint: sanitizeUrl(rpcUrl), wallets: candidates }, null, 2),
  );
  console.error(`Selected ${candidates.length} wallets → ${SELECTION_OUT}`);

  // Step 3 — for each selected wallet fetch full transactions and stream into
  // a gzipped JSONL file. We write line-by-line so the output is streamable
  // and doesn't require buffering all results in memory.
  const gzip = zlib.createGzip();
  const out = createWriteStream(HISTORY_OUT);
  gzip.pipe(out);

  let totalLines = 0;
  for (const { wallet, mint } of candidates) {
    console.error(`  fetching tx history for ${wallet}...`);
    let sigs: SignatureInfo[];
    try {
      sigs = (await pool.call('getSignaturesForAddress', [wallet, { limit: 1000 }])) as SignatureInfo[];
    } catch (err) {
      console.error(`    getSignaturesForAddress failed: ${(err as Error).message} — skipping wallet`);
      continue;
    }

    let walletLines = 0;
    for (const s of sigs) {
      if (s.blockTime === null || s.blockTime < sinceSec) continue;
      let tx: unknown;
      try {
        tx = await pool.call('getTransaction', [
          s.signature,
          { maxSupportedTransactionVersion: 0, encoding: 'json' },
        ]);
      } catch (err) {
        console.error(`    getTransaction(${s.signature}) failed: ${(err as Error).message} — skipping`);
        continue;
      }
      if (!tx) continue;

      const line = JSON.stringify({
        wallet,
        mint,
        signature: s.signature,
        slot: s.slot,
        tx,
      });
      gzip.write(line + '\n');
      walletLines += 1;
      totalLines += 1;
    }
    console.error(`    wrote ${walletLines} tx records for ${wallet}`);
  }

  gzip.end();
  await new Promise<void>((resolve) => out.on('close', () => resolve()));
  console.error(`Captured ${totalLines} tx records → ${HISTORY_OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

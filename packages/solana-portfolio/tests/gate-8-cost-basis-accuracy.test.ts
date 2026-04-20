import { describe, it, expect } from 'vitest';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { PublicKey } from '@ap3x/solana-core';
import { CostBasisReconstructor, SwapTracerRegistry, SplTransferSwapTracer } from '@ap3x/solana-portfolio';

// ESM-safe __dirname: points to packages/solana-portfolio/tests/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Worktree root is three levels up: packages/solana-portfolio/tests/ → ../../../
const FIXTURE_ROOT = path.resolve(__dirname, '../../../tests/fixtures');

const SELECTION_PATH = path.join(FIXTURE_ROOT, 'portfolio-cold-start-wallets.json');
const HISTORY_PATH = path.join(FIXTURE_ROOT, 'cold-start-tx-history.jsonl.gz');
const TOLERANCE = 1n; // ±1 lamport (rent-exempt minimum dust)

const itIfFixture = existsSync(HISTORY_PATH) ? it : it.skip;

describe('gate 8: cost-basis reconstruction ±1 lamport accuracy', () => {
  itIfFixture('reconstructs each of the 10 wallets within tolerance', async () => {
    const selection = JSON.parse(await fs.readFile(SELECTION_PATH, 'utf8'));
    const txByWalletSig = new Map<string, any>();
    {
      const gz = zlib.createGunzip();
      createReadStream(HISTORY_PATH).pipe(gz);
      const rl = readline.createInterface({ input: gz, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        txByWalletSig.set(`${j.wallet}:${j.signature}`, j.tx);
      }
    }

    for (const { wallet: walletStr, mint: mintStr } of selection.wallets) {
      const wallet = PublicKey.fromBase58(walletStr);
      const mint = PublicKey.fromBase58(mintStr);
      const sigs = [...txByWalletSig.entries()]
        .filter(([k]) => k.startsWith(walletStr + ':'))
        .map(([, tx]) => ({ signature: tx.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime ?? null }));

      const fakeRpcPool: any = {
        call: async (method: string, params: unknown[]) => {
          if (method === 'getSignaturesForAddress') return sigs;
          if (method === 'getTransaction') {
            const [sig] = params as [string];
            return txByWalletSig.get(`${walletStr}:${sig}`);
          }
          return null;
        },
      };

      const registry = new SwapTracerRegistry();
      registry.register(new SplTransferSwapTracer());

      const recon = new CostBasisReconstructor({ rpcPool: fakeRpcPool, tracerRegistry: registry, lookbackDays: 90 });
      const onChainPost = sigs[0]?.signature ? txByWalletSig.get(`${walletStr}:${sigs[0]!.signature}`)?.meta.postTokenBalances?.find((b: any) => b.owner === walletStr && b.mint === mintStr)?.uiTokenAmount?.amount : '0';
      const balance = BigInt(onChainPost ?? '0');
      const lots = await recon.reconstruct(wallet, mint, balance);

      // Total reconstructed amount must cover the current balance.
      // The reconstructor is greedy — the last lot may overshoot — so
      // totalAmount >= balance (not necessarily ===).
      const totalAmount = lots.reduce((s, l) => s + l.amount, 0n);
      expect(totalAmount).toBeGreaterThanOrEqual(balance);

      // For each `cold-start-reconstructed` lot, verify costBasis is within tolerance of the SOL outflow recorded in the source tx.
      for (const lot of lots) {
        if (lot.source !== 'cold-start-reconstructed') continue;
        const tx = txByWalletSig.get(`${walletStr}:${lot.acquiredSig}`);
        if (!tx) continue;
        const accountIdx = tx.transaction.message.accountKeys.indexOf(walletStr);
        if (accountIdx < 0) continue;
        const expected = BigInt(tx.meta.preBalances[accountIdx]) - BigInt(tx.meta.postBalances[accountIdx]) - BigInt(tx.meta.fee);
        const diff = lot.costBasisLamports > expected ? lot.costBasisLamports - expected : expected - lot.costBasisLamports;
        expect(diff).toBeLessThanOrEqual(TOLERANCE);
      }
    }
  });
});

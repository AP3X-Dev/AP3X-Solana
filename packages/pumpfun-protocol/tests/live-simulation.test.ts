/**
 * Live check against the deployed pump.fun program: build a bonding-curve buy
 * from on-chain state and run it through `simulateTransaction` with signature
 * verification off, so no keypair or funds of our own are needed.
 *
 * Opt-in (network): AP3X_LIVE_RPC=<mainnet rpc url> pnpm vitest run tests/live-simulation.test.ts
 */
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { parseLogs, walkInvocations } from '@ap3x/solana-events';
import { bondingCurveDecoder, PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { createAssociatedTokenAccountIx } from '@ap3x/solana-spl';
import { assemble } from '@ap3x/solana-tx';
import { buildBuyExactSolIn, curveState, feeRecipientFor, globalState } from '../src/index.js';

const RPC = process.env['AP3X_LIVE_RPC'];

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 10) {
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** Math.min(attempt, 4)));
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }
}

const pool = { call: (method: string, params: unknown[]) => rpc(method, params) } as never;

/** Recent pump.fun trades: a mint still on its curve, and a trader with SOL. */
async function findMintAndPayer(): Promise<{ mint: PublicKey; payer: PublicKey }> {
  const sigs = await rpc<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [
    PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58(),
    { limit: 40 },
  ]);
  for (const s of sigs.filter((x) => !x.err)) {
    const tx = await rpc<{ meta: { logMessages: string[] } } | null>('getTransaction', [
      s.signature,
      { maxSupportedTransactionVersion: 1 },
    ]);
    if (!tx) continue;
    for (const { chunk } of walkInvocations(parseLogs(tx.meta.logMessages))) {
      if (chunk.programId !== PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58()) continue;
      for (const ev of bondingCurveDecoder.decodeAll(chunk)) {
        if (ev.kind !== 'pumpfun.trade') continue;
        const curve = await curveState(pool, ev.mint).catch(() => null);
        if (!curve || curve.complete) continue;
        // The payer must be a plain system account (a PDA cannot pay fees).
        const { value: acct } = await rpc<{ value: { owner: string; lamports: number } | null }>('getAccountInfo', [
          ev.user.toBase58(),
          { encoding: 'base64' },
        ]);
        if (acct?.owner === '11111111111111111111111111111111' && acct.lamports > 50_000_000) {
          return { mint: ev.mint, payer: ev.user };
        }
      }
    }
  }
  throw new Error('no suitable live mint/payer in recent pump.fun activity');
}

describe.skipIf(!RPC)('pump.fun live simulation', () => {
  it('the deployed program accepts a buy_exact_sol_in built from on-chain state', async () => {
    const { mint, payer } = await findMintAndPayer();
    const [global, curve, mintInfo] = await Promise.all([
      globalState(pool),
      curveState(pool, mint),
      rpc<{ value: { owner: string } }>('getAccountInfo', [mint.toBase58(), { encoding: 'base64' }]),
    ]);
    const tokenProgram = PublicKey.fromBase58(mintInfo.value.owner);
    const buybackFeeRecipient = global.buybackFeeRecipients[0];
    expect(buybackFeeRecipient, 'Global has buyback fee recipients').toBeDefined();

    const instructions = [
      createAssociatedTokenAccountIx(payer, payer, mint, tokenProgram),
      buildBuyExactSolIn({
        mint,
        user: payer,
        feeRecipient: feeRecipientFor(global, curve),
        creator: curve.creator,
        buybackFeeRecipient: buybackFeeRecipient!,
        tokenProgram,
        spendableSolIn: 1_000_000n, // 0.001 SOL
        minTokensOut: 1n,
      }),
    ];
    const { value: bh } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', []);
    // Signature verification is off in the simulation, so a zero signature
    // stands in for the payer's.
    const { signedTransaction } = await assemble({
      instructions,
      payer,
      signers: [{ address: payer, sign: async () => new Uint8Array(64) }],
      recentBlockhash: bh.blockhash,
    });

    const sim = await rpc<{ value: { err: unknown; logs: string[] | null } }>('simulateTransaction', [
      Buffer.from(signedTransaction).toString('base64'),
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' },
    ]);
    if (sim.value.err) console.error(sim.value.logs?.join('\n'));
    expect(sim.value.err).toBeNull();
    expect(sim.value.logs?.some((l) => l.includes('Instruction: BuyExactSolIn'))).toBe(true);
  }, 180_000);
});

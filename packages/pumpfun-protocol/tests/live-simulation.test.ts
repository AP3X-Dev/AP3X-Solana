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
import { bondingCurveDecoder, PUMPFUN_BONDING_CURVE_PROGRAM_ID, pumpSwapDecoder, PUMPFUN_PUMPSWAP_PROGRAM_ID, PUMP_SCHEMA } from '@ap3x/pumpfun-events';
import {
  closeAccountIx,
  createAssociatedTokenAccountIx,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  syncNativeIx,
} from '@ap3x/solana-spl';
import { assemble, systemTransfer, type Instruction } from '@ap3x/solana-tx';
import {
  buildIdlInstruction,
  buildBuy,
  buildBuyV2,
  buildSell,
  buildBuyExactQuoteInV2,
  buildBuyExactSolIn,
  buildSellV2,
  checkProgramUpgrades,
  curveState,
  feeRecipientFor,
  globalState,
} from '../src/index.js';

const RPC = process.env['AP3X_LIVE_RPC'];

// This harness cannot broadcast, even if a future test accidentally tries to.
const ALLOWED_RPC = new Set(['getSignaturesForAddress', 'getTransaction', 'getAccountInfo',
  'getMultipleAccounts', 'getLatestBlockhash', 'simulateTransaction']);
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!ALLOWED_RPC.has(method)) throw new Error(`live validation forbids RPC method ${method}`);
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
async function findMintAndPayer(excludeCashback = false): Promise<{ mint: PublicKey; payer: PublicKey }> {
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
        if (!curve || curve.complete || (excludeCashback && curve.isCashbackCoin)) continue;
        // This suite qualifies SOL/WSOL only. Nested/custom quote coins need a separate witness.
        if (curve.quoteMint && !curve.quoteMint.equals(NATIVE_MINT)
          && !curve.quoteMint.equals(PublicKey.fromBytes(new Uint8Array(32)))) continue;
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

async function simulate(payer: PublicKey, instructions: Instruction[], expectedFailure = false) {
  const { value: bh } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', []);
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
  if (sim.value.err && !expectedFailure) console.error(sim.value.logs?.join('\n'));
  const trades = [];
  for (const { chunk } of walkInvocations(parseLogs(sim.value.logs ?? []))) {
    if (chunk.programId !== PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58() || chunk.dataPayloads.length === 0) continue;
    const events = bondingCurveDecoder.decodeAll(chunk);
    for (const event of events) {
      expect(event.kind, `simulation event must decode: ${'reason' in event ? event.reason : ''}`).not.toBe('unknown');
      if (event.kind === 'pumpfun.trade') trades.push(event);
    }
  }
  console.log('simulation witness', JSON.stringify({ err: sim.value.err, trades },
    (_key, value) => typeof value === 'bigint' ? value.toString()
      : value instanceof PublicKey ? value.toBase58() : value));
  return { ...sim.value, trades };
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
    const sim = await simulate(payer, instructions);
    expect(sim.err).toBeNull();
    expect(sim.logs?.some((l) => l.includes('Instruction: BuyExactSolIn'))).toBe(true);

  }, 180_000);

  it('the deployed program accepts v2 buy and sell against a WSOL quote account', async () => {
    const { mint, payer } = await findMintAndPayer();
    const [global, curve, mintInfo] = await Promise.all([
      globalState(pool),
      curveState(pool, mint),
      rpc<{ value: { owner: string } }>('getAccountInfo', [mint.toBase58(), { encoding: 'base64' }]),
    ]);
    const baseTokenProgram = PublicKey.fromBase58(mintInfo.value.owner);
    const accounts = {
      baseMint: mint,
      quoteMint: NATIVE_MINT,
      user: payer,
      feeRecipient: feeRecipientFor(global, curve),
      buybackFeeRecipient: global.buybackFeeRecipients[0]!,
      creator: curve.creator,
      baseTokenProgram,
    };
    const wsol = getAssociatedTokenAddress(NATIVE_MINT, payer, true);
    const value = await simulate(payer, [
      createAssociatedTokenAccountIx(payer, payer, mint, baseTokenProgram),
      createAssociatedTokenAccountIx(payer, payer, NATIVE_MINT),
      systemTransfer(payer, wsol, 1_000_000n),
      syncNativeIx(wsol),
      buildBuyExactQuoteInV2({ ...accounts, spendableQuoteIn: 1_000_000n, minTokensOut: 1n }),
      buildSellV2({ ...accounts, amount: 1_000n, minSolOutput: 0n }),
      closeAccountIx(wsol, payer, payer),
    ]);
    expect(value.err).toBeNull();
    expect(value.logs?.some((l) => l.includes('Instruction: BuyExactQuoteInV2'))).toBe(true);
    expect(value.logs?.some((l) => l.includes('Instruction: SellV2'))).toBe(true);
  }, 180_000);

  for (const v2 of [false, true]) it(`${v2 ? 'v2' : 'legacy'} exact-output roundtrip and slippage guards`, async () => {
    const { mint, payer } = await findMintAndPayer();
    const [global, curve, mintInfo] = await Promise.all([
      globalState(pool), curveState(pool, mint),
      rpc<{ value: { owner: string } }>('getAccountInfo', [mint.toBase58(), { encoding: 'base64' }]),
    ]);
    const tokenProgram = PublicKey.fromBase58(mintInfo.value.owner);
    const common = { user: payer, creator: curve.creator,
      feeRecipient: feeRecipientFor(global, curve), buybackFeeRecipient: global.buybackFeeRecipients[0]! };
    expect(common.buybackFeeRecipient).toBeDefined();
    const legacy = { ...common, mint, tokenProgram, cashback: curve.isCashbackCoin };
    const modern = { ...common, baseMint: mint, quoteMint: NATIVE_MINT, baseTokenProgram: tokenProgram };
    const setup = [createAssociatedTokenAccountIx(payer, payer, mint, tokenProgram)];
    if (v2) setup.push(createAssociatedTokenAccountIx(payer, payer, NATIVE_MINT),
      systemTransfer(payer, getAssociatedTokenAddress(NATIVE_MINT, payer, true), 1_000_000n),
      syncNativeIx(getAssociatedTokenAddress(NATIVE_MINT, payer, true)));
    const amount = 1_000_000n;
    const buyIx = (maxSolCost: bigint) => v2
      ? buildBuyV2({ ...modern, amount, maxSolCost }) : buildBuy({ ...legacy, amount, maxSolCost });
    const sellIx = (minSolOutput: bigint) => v2
      ? buildSellV2({ ...modern, amount, minSolOutput }) : buildSell({ ...legacy, amount, minSolOutput });
    const accepted = await simulate(payer, [...setup, buyIx(1_000_000n), sellIx(0n)]);
    expect(accepted.err).toBeNull();
    expect(accepted.trades).toHaveLength(2);
    for (const [index, trade] of accepted.trades.entries()) {
      expect(trade.mint.equals(mint)).toBe(true);
      expect(trade.user.equals(payer)).toBe(true);
      expect(trade.isBuy).toBe(index === 0);
      expect(trade.tokenAmount).toBe(amount);
      expect(trade.solAmount).toBeGreaterThan(0n);
      // Require measured fee fields rather than treating absent fees as zero.
      expect(typeof trade.fee).toBe('bigint');
      expect(typeof trade.creatorFee).toBe('bigint');
      expect(trade.fee!).toBeGreaterThanOrEqual(0n);
      expect(trade.creatorFee!).toBeGreaterThanOrEqual(0n);
    }
    const capped = await simulate(payer, [...setup, buyIx(1n)], true);
    expect(capped.err).toEqual({ InstructionError: [setup.length, { Custom: 6002 }] });
    const minimum = await simulate(payer, [...setup, buyIx(1_000_000n), sellIx((1n << 64n) - 1n)], true);
    expect(minimum.err).toEqual({ InstructionError: [setup.length + 1, { Custom: 6003 }] });
  }, 180_000);

  it('v3 SOL roundtrip uses the smaller account set and deferred-fee event marker', async () => {
    const { mint, payer } = await findMintAndPayer(true);
    const [global, mintInfo] = await Promise.all([
      globalState(pool),
      rpc<{ value: { owner: string } }>('getAccountInfo', [mint.toBase58(), { encoding: 'base64' }]),
    ]);
    const tokenProgram = PublicKey.fromBase58(mintInfo.value.owner);
    expect(global.buybackFeeRecipients[0]).toBeDefined();
    const known = { base_mint: mint, quote_mint: NATIVE_MINT, base_token_program: tokenProgram,
      quote_token_program: TOKEN_PROGRAM_ID, user: payer,
      associated_base_user: getAssociatedTokenAddress(mint, payer, true, tokenProgram),
      associated_quote_user: getAssociatedTokenAddress(NATIVE_MINT, payer, true),
      buyback_fee_recipient: global.buybackFeeRecipients[0]! };
    const value = await simulate(payer, [createAssociatedTokenAccountIx(payer, payer, mint, tokenProgram),
      buildIdlInstruction(PUMP_SCHEMA, 'buy_v3', known, { amount: 1_000_000n, maxSolCost: 1_000_000n }),
      buildIdlInstruction(PUMP_SCHEMA, 'sell_v3', known, { amount: 1_000_000n, minSolOutput: 0n }),
    ]);
    expect(value.err).toBeNull();
    // Live v3 emits ixName buy/sell, despite the public docs naming buy_v3/sell_v3.
    // Use invocation logs to identify the instruction; preserve the event's raw fact.
    expect(value.logs?.some(l => l.includes('Instruction: BuyV3'))).toBe(true);
    expect(value.logs?.some(l => l.includes('Instruction: SellV3'))).toBe(true);
    expect(value.trades.map(t => t.isBuy)).toEqual([true, false]);
    for (const trade of value.trades) {
      expect(trade.tokenAmount).toBe(1_000_000n);
      expect(trade.feeRecipient?.toBase58()).toBe('11111111111111111111111111111111');
      expect(typeof trade.fee).toBe('bigint');
      expect(typeof trade.creatorFee).toBe('bigint');
    }
  }, 180_000);

  it('the deployed programs match the deployments the IDLs were verified against', async () => {
    const checks = await checkProgramUpgrades(pool);
    console.log('deployment witness', JSON.stringify(checks.map(c => ({
      programId: c.programId.toBase58(), deployedSlot: String(c.deployedSlot),
      verifiedSlot: String(c.verifiedSlot), upgraded: c.upgraded,
    }))));
    for (const c of checks) {
      expect(c.upgraded, `${c.programId.toBase58()} redeployed at ${c.deployedSlot}, verified ${c.verifiedSlot}`).toBe(false);
    }
  }, 60_000);

  it('PumpSwap prices sells against effective quote reserves (vault + virtual)', async () => {
    const sigs = await rpc<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58(), { limit: 40 }]);
    let checked = 0;
    for (const s of sigs.filter((x) => !x.err)) {
      const tx = await rpc<{ meta: { logMessages: string[] } } | null>('getTransaction', [s.signature, { maxSupportedTransactionVersion: 1 }]);
      if (!tx) continue;
      for (const { chunk } of walkInvocations(parseLogs(tx.meta.logMessages))) {
        if (chunk.programId !== PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58()) continue;
        for (const e of pumpSwapDecoder.decodeAll(chunk)) {
          if (e.kind !== 'pumpswap.sell') continue;
          const effectiveQuote = e.poolQuoteTokenReserves + ((e['virtualQuoteReserves'] as bigint | undefined) ?? 0n);
          // Constant product on the effective reserves, before fees.
          expect(e.quoteAmountOut).toBe((effectiveQuote * e.baseAmountIn) / (e.poolBaseTokenReserves + e.baseAmountIn));
          if (++checked >= 5) return;
        }
      }
    }
    expect(checked, 'recent PumpSwap sells to check').toBeGreaterThan(0);
  }, 300_000);
});

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { adaptToLandedTrades } from './landed-trade-adapter.js';
import type { RpcPoolLike } from './landed-trade-adapter.js';
import type { ExecutionResult } from '@ap3x/solana-executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal RPC fake — only handles `getTransaction`. Tracks call count so
 * tests can assert the network was never hit for non-landed results.
 */
class FakeRpcPool implements RpcPoolLike {
  callCount = 0;

  constructor(private readonly payload: unknown) {}

  async call(method: string, _params: unknown): Promise<unknown> {
    if (method !== 'getTransaction') throw new Error('unexpected method: ' + method);
    this.callCount++;
    return this.payload;
  }
}

/**
 * Build a minimal `landed` ExecutionResult.
 */
function landedResult(overrides?: Partial<Extract<ExecutionResult, { kind: 'landed' }>>): ExecutionResult {
  return {
    kind: 'landed',
    intentId: 'intent-1',
    signature: '5eSaFPLaGbQqhD5HM13vS4FPzN5AYVDAtBDkSLxr9YWNqfcHNf3MMHE9xzVbwqnpE7rXZXADR1Vt2H3pEyGKjVT',
    slot: 300_000,
    submitterUsed: 'rpc',
    landedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Realistic public keys (32-byte base58)
// ---------------------------------------------------------------------------

const WALLET  = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MINT_A  = PublicKey.fromBase58('So11111111111111111111111111111111111111112');
const MINT_B  = PublicKey.fromBase58('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MINT_C  = PublicKey.fromBase58('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

const WALLET_STR = WALLET.toBase58();
const MINT_A_STR = MINT_A.toBase58();
const MINT_B_STR = MINT_B.toBase58();
const MINT_C_STR = MINT_C.toBase58();

const OTHER_OWNER = 'BrEAK1111111111111111111111111111111111111111';

/**
 * Build a getTransaction payload with the given pre/post balances.
 */
function buildTxPayload(opts: {
  preBalances: number[];
  postBalances: number[];
  fee: number;
  preTokenBalances?: Array<{ mint: string; owner: string; amount: string }>;
  postTokenBalances?: Array<{ mint: string; owner: string; amount: string }>;
  includeWalletInAccountKeys?: boolean;
}): unknown {
  const {
    preBalances,
    postBalances,
    fee,
    preTokenBalances = [],
    postTokenBalances = [],
    includeWalletInAccountKeys = true,
  } = opts;

  const accountKeys = ['FILLER111111111111111111111111111111111111111', WALLET_STR];
  if (!includeWalletInAccountKeys) {
    accountKeys[1] = 'NOBODY11111111111111111111111111111111111111';
  }

  const toTokenBalance = (entries: Array<{ mint: string; owner: string; amount: string }>) =>
    entries.map((e, i) => ({
      accountIndex: i + 2,
      mint: e.mint,
      owner: e.owner,
      uiTokenAmount: {
        amount: e.amount,
        decimals: 6,
        uiAmount: Number(e.amount) / 1e6,
        uiAmountString: (Number(e.amount) / 1e6).toString(),
      },
    }));

  return {
    slot: 300_000,
    version: 0,
    meta: {
      fee,
      preBalances,
      postBalances,
      preTokenBalances: toTokenBalance(preTokenBalances),
      postTokenBalances: toTokenBalance(postTokenBalances),
      err: null,
    },
    transaction: {
      message: {
        // slot 0 = filler, slot 1 = wallet (unless overridden)
        accountKeys: includeWalletInAccountKeys
          ? ['FILLER111111111111111111111111111111111111111', WALLET_STR]
          : ['FILLER111111111111111111111111111111111111111', 'NOBODY11111111111111111111111111111111111111'],
        instructions: [],
        recentBlockhash: 'BLOCKHASH',
      },
      signatures: ['5eSaFPLaGbQqhD5HM13vS4FPzN5AYVDAtBDkSLxr9YWNqfcHNf3MMHE9xzVbwqnpE7rXZXADR1Vt2H3pEyGKjVT'],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('adaptToLandedTrades', () => {

  // -------------------------------------------------------------------------
  // Test 1 — mixed token deltas (buy one mint, sell another, new mint, closed)
  // -------------------------------------------------------------------------

  it('1. landed: mixed token deltas produce correct LandedTrade per mint', async () => {
    // MINT_A: pre=1000, post=5000  → delta=+4000 (buy)
    // MINT_B: pre=8000, post=3000  → delta=-5000 (sell)
    // MINT_C: post-only=2000       → delta=+2000 (new position / airdrop)
    // pre-only MINT for different owner (MINT_A with other owner) — should be ignored
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 40_000_000],
      fee: 5000,
      preTokenBalances: [
        { mint: MINT_A_STR, owner: WALLET_STR, amount: '1000' },
        { mint: MINT_B_STR, owner: WALLET_STR, amount: '8000' },
      ],
      postTokenBalances: [
        { mint: MINT_A_STR, owner: WALLET_STR, amount: '5000' },
        { mint: MINT_B_STR, owner: WALLET_STR, amount: '3000' },
        { mint: MINT_C_STR, owner: WALLET_STR, amount: '2000' },
      ],
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    expect(result).toHaveLength(3);

    const mintAResult = result.find((t) => t.mint.toBase58() === MINT_A_STR);
    const mintBResult = result.find((t) => t.mint.toBase58() === MINT_B_STR);
    const mintCResult = result.find((t) => t.mint.toBase58() === MINT_C_STR);

    expect(mintAResult?.amountDelta).toBe(4000n);
    expect(mintBResult?.amountDelta).toBe(-5000n);
    expect(mintCResult?.amountDelta).toBe(2000n);
  });

  // -------------------------------------------------------------------------
  // Test 2 — positive SOL delta (sold tokens, received SOL)
  // -------------------------------------------------------------------------

  it('2. landed: positive SOL delta when wallet receives SOL', async () => {
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 60_000_000], // +10_000_000 lamports
      fee: 5000,
      preTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '5000' }],
      postTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '3000' }],
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    expect(result).toHaveLength(1);
    expect(result[0]!.solFlowLamports).toBe(10_000_000n); // positive
    expect(result[0]!.solFlowLamports).toBeGreaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // Test 3 — negative SOL delta (paid SOL to buy tokens)
  // -------------------------------------------------------------------------

  it('3. landed: negative SOL delta when wallet pays SOL for tokens', async () => {
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 39_995_000], // -10_005_000 lamports (10 SOL + fee)
      fee: 5000,
      preTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '0' }],
      postTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '10000' }],
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    expect(result).toHaveLength(1);
    expect(result[0]!.solFlowLamports).toBe(-10_005_000n); // negative
    expect(result[0]!.solFlowLamports).toBeLessThan(0n);
  });

  // -------------------------------------------------------------------------
  // Test 4 — no token changes for our wallet → returns []
  // -------------------------------------------------------------------------

  it('4. landed: no token changes for our wallet returns []', async () => {
    // All token balances belong to a different owner
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 50_000_000],
      fee: 5000,
      preTokenBalances: [{ mint: MINT_A_STR, owner: OTHER_OWNER, amount: '1000' }],
      postTokenBalances: [{ mint: MINT_A_STR, owner: OTHER_OWNER, amount: '5000' }],
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 5 — getTransaction returns null → returns []
  // -------------------------------------------------------------------------

  it('5. landed but getTransaction returns null → returns []', async () => {
    const pool = new FakeRpcPool(null);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });
    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 5b — getTransaction returns object with null meta → returns []
  // -------------------------------------------------------------------------

  it('5b. landed but meta is null → returns []', async () => {
    const payload = {
      slot: 300_000,
      version: 0,
      meta: null,
      transaction: {
        message: { accountKeys: [WALLET_STR], instructions: [], recentBlockhash: 'BH' },
        signatures: ['sig'],
      },
    };
    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });
    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 6 — wallet NOT in accountKeys → solDelta=0n, token deltas still extracted
  // -------------------------------------------------------------------------

  it('6. wallet not in accountKeys: solFlowLamports=0n but token deltas extracted', async () => {
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 40_000_000],
      fee: 5000,
      preTokenBalances: [],
      postTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '3000' }],
      includeWalletInAccountKeys: false,
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    // Token delta should still be extracted (MINT_A post=3000, pre=0 → +3000)
    expect(result).toHaveLength(1);
    expect(result[0]!.solFlowLamports).toBe(0n);
    expect(result[0]!.amountDelta).toBe(3000n);
  });

  // -------------------------------------------------------------------------
  // Test 7 — reverted result → returns [], no RPC call
  // -------------------------------------------------------------------------

  it('7. reverted result: returns [] without calling RPC', async () => {
    const pool = new FakeRpcPool(null);
    const result: ExecutionResult = {
      kind: 'reverted',
      intentId: 'intent-1',
      signature: 'sig',
      slot: 300_000,
      submitterUsed: 'rpc',
      logs: ['Program failed'],
      error: 'InstructionError',
    };
    const out = await adaptToLandedTrades(result, { rpcPool: pool, walletAddress: WALLET });
    expect(out).toHaveLength(0);
    expect(pool.callCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 8 — timeout, dropped, rejected → returns [], no RPC call
  // -------------------------------------------------------------------------

  it('8a. timeout result: returns [] without calling RPC', async () => {
    const pool = new FakeRpcPool(null);
    const result: ExecutionResult = {
      kind: 'timeout',
      intentId: 'intent-1',
      submitterUsed: 'rpc',
    };
    const out = await adaptToLandedTrades(result, { rpcPool: pool, walletAddress: WALLET });
    expect(out).toHaveLength(0);
    expect(pool.callCount).toBe(0);
  });

  it('8b. dropped result: returns [] without calling RPC', async () => {
    const pool = new FakeRpcPool(null);
    const result: ExecutionResult = {
      kind: 'dropped',
      intentId: 'intent-1',
      submitterUsed: 'rpc',
    };
    const out = await adaptToLandedTrades(result, { rpcPool: pool, walletAddress: WALLET });
    expect(out).toHaveLength(0);
    expect(pool.callCount).toBe(0);
  });

  it('8c. rejected result: returns [] without calling RPC', async () => {
    const pool = new FakeRpcPool(null);
    const result: ExecutionResult = {
      kind: 'rejected',
      intentId: 'intent-1',
      error: { code: 'wallet_locked', message: 'wallet is locked' },
    };
    const out = await adaptToLandedTrades(result, { rpcPool: pool, walletAddress: WALLET });
    expect(out).toHaveLength(0);
    expect(pool.callCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 9 — feeLamports correctly extracted from tx.meta.fee
  // -------------------------------------------------------------------------

  it('9. feeLamports matches tx.meta.fee', async () => {
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 45_000_000],
      fee: 25_000,
      preTokenBalances: [],
      postTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '100' }],
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    expect(result).toHaveLength(1);
    expect(result[0]!.feeLamports).toBe(25_000n);
  });

  // -------------------------------------------------------------------------
  // Test 10 — source: 'executor' on every emitted trade
  // -------------------------------------------------------------------------

  it('10. source is always "executor" on emitted trades', async () => {
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 40_000_000],
      fee: 5000,
      preTokenBalances: [],
      postTokenBalances: [
        { mint: MINT_A_STR, owner: WALLET_STR, amount: '1000' },
        { mint: MINT_B_STR, owner: WALLET_STR, amount: '2000' },
      ],
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    expect(result.length).toBeGreaterThan(0);
    for (const trade of result) {
      expect(trade.source).toBe('executor');
    }
  });

  // -------------------------------------------------------------------------
  // Bonus — pre-only (fully closed position) produces negative delta
  // -------------------------------------------------------------------------

  it('bonus: pre-only token entry (closed position) produces negative delta', async () => {
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 59_995_000],
      fee: 5000,
      preTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '7500' }],
      postTokenBalances: [], // account closed
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    expect(result).toHaveLength(1);
    expect(result[0]!.amountDelta).toBe(-7500n);
  });

  // -------------------------------------------------------------------------
  // Bonus — zero delta is filtered out
  // -------------------------------------------------------------------------

  it('bonus: zero-delta token entries are excluded', async () => {
    const payload = buildTxPayload({
      preBalances: [100_000_000, 50_000_000],
      postBalances: [100_000_000, 50_000_000],
      fee: 5000,
      preTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '1000' }],
      postTokenBalances: [{ mint: MINT_A_STR, owner: WALLET_STR, amount: '1000' }], // no change
    });

    const pool = new FakeRpcPool(payload);
    const result = await adaptToLandedTrades(landedResult(), { rpcPool: pool, walletAddress: WALLET });

    expect(result).toHaveLength(0);
  });
});

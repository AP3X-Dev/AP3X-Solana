// Port of `gmgn_tracker.helius.parser.parse_buy` used only by the replay-parity
// suite. Lives in the test tree because the substrate's normalizer is
// wallet-agnostic on purpose — BUY classification is a vertical concern that
// belongs in `@ap3x/pumpfun-signals` (or its successor) rather than the driver.
//
// The shape of the output mirrors the Python `Buy` projection emitted by
// `parity_helper.py` so the test can do field-level diffing.

import type { HeliusEnhancedTx } from '../../src/drivers/helius/normalize.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const USDY_MINT = 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6';
const USDS_MINT = 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA';
const FDUSD_MINT = '9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh7hF';

const STABLES = new Set<string>([
  SOL_MINT, USDC_MINT, USDT_MINT,
  USD1_MINT, PYUSD_MINT, USDY_MINT, USDS_MINT, FDUSD_MINT,
]);

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface BuyProjection {
  signature: string;
  wallet_address: string;
  token_mint: string;
  sol_amount: number;
  token_amount: number;
  block_time_unix: number;
}

/**
 * Classify a Helius enhanced-tx as a buy by `wallet`, or return null. Mirrors
 * the Python reference parser line-for-line; any divergence here is a parity
 * regression and the suite should fail.
 */
export function classifyHeliusBuy(
  tx: HeliusEnhancedTx,
  wallet: string,
): BuyProjection | null {
  if (tx.transactionError) return null;

  const type = tx.type;
  if (type !== 'SWAP' && type !== 'TOKEN_MINT') return null;

  const tokenTransfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  // Target mint = max-amount non-stable SPL token received by wallet.
  let targetMint: string | null = null;
  let targetAmount = 0;
  for (const t of tokenTransfers) {
    if (t.toUserAccount !== wallet) continue;
    const mint = t.mint;
    if (STABLES.has(mint)) continue;
    const amount = Number(t.tokenAmount ?? 0);
    if (amount > targetAmount) {
      targetMint = mint;
      targetAmount = amount;
    }
  }
  if (targetMint === null || targetAmount <= 0) return null;

  // Funding leg: stables sent from wallet (token transfers) + native lamports
  // sent from wallet, converted to SOL.
  let solSpent = 0;
  for (const t of tokenTransfers) {
    if (t.fromUserAccount !== wallet) continue;
    if (!STABLES.has(t.mint)) continue;
    solSpent += Number(t.tokenAmount ?? 0);
  }
  for (const n of nativeTransfers) {
    if (n.fromUserAccount !== wallet) continue;
    solSpent += Number(n.amount ?? 0) / LAMPORTS_PER_SOL;
  }
  if (solSpent <= 0) return null;

  if (typeof tx.timestamp !== 'number') return null;

  return {
    signature: tx.signature,
    wallet_address: wallet,
    token_mint: targetMint,
    sol_amount: solSpent,
    token_amount: targetAmount,
    block_time_unix: Math.trunc(tx.timestamp),
  };
}

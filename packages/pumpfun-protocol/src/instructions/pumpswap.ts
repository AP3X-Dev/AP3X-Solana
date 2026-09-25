import { PublicKey } from '@ap3x/solana-core';
import type { AccountMeta, Instruction } from '@ap3x/solana-tx';
import { PUMP_AMM_SCHEMA, PUMPFUN_PUMPSWAP_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import { derivePoolV2Pda, derivePumpSwapGlobalConfigPda } from '../pumpswap/pool-state.js';
import { deriveUserVolumeAccumulatorPda } from './account-derivation.js';
import { buildIdlInstruction } from './idl-instruction.js';
import type {
  PumpSwapBuyExactQuoteInParams,
  PumpSwapBuyParams,
  PumpSwapSellParams,
  PumpSwapTradeAccounts,
} from './params.js';

const ZERO = /* @__PURE__ */ PublicKey.fromBytes(new Uint8Array(32));

function positive(name: string, v: bigint): void {
  if (v <= 0n) throw new TypeError(`${name} must be > 0`);
}

function tradeAccounts(p: PumpSwapTradeAccounts): Record<string, PublicKey> {
  const baseTokenProgram = p.baseTokenProgram ?? TOKEN_PROGRAM_ID;
  const quoteTokenProgram = p.quoteTokenProgram ?? TOKEN_PROGRAM_ID;
  return {
    pool: p.pool.pool,
    user: p.user,
    global_config: derivePumpSwapGlobalConfigPda().address,
    base_mint: p.pool.baseMint,
    quote_mint: p.pool.quoteMint,
    user_base_token_account:
      p.userBaseTokenAccount ?? getAssociatedTokenAddress(p.pool.baseMint, p.user, true, baseTokenProgram),
    user_quote_token_account:
      p.userQuoteTokenAccount ?? getAssociatedTokenAddress(p.pool.quoteMint, p.user, true, quoteTokenProgram),
    pool_base_token_account: p.pool.poolBaseTokenAccount,
    pool_quote_token_account: p.pool.poolQuoteTokenAccount,
    protocol_fee_recipient: p.protocolFeeRecipient,
    base_token_program: baseTokenProgram,
    quote_token_program: quoteTokenProgram,
    'pool.coin_creator': p.pool.coinCreator,
  };
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

/**
 * Trailing accounts: cashback accounts (cashback coins only; sell also passes
 * the accumulator itself), `pool-v2` (pools with a coin creator), then the
 * buyback fee recipient and its quote-mint ATA.
 */
function remainingAccounts(p: PumpSwapTradeAccounts, side: 'buy' | 'sell'): AccountMeta[] {
  const quoteTokenProgram = p.quoteTokenProgram ?? TOKEN_PROGRAM_ID;
  const out: AccountMeta[] = [];
  if (p.pool.isCashbackCoin) {
    const accumulator = deriveUserVolumeAccumulatorPda(p.user, PUMPFUN_PUMPSWAP_PROGRAM_ID).address;
    out.push(rw(getAssociatedTokenAddress(p.pool.quoteMint, accumulator, true, quoteTokenProgram)));
    if (side === 'sell') out.push(rw(accumulator));
  }
  if (!p.pool.coinCreator.equals(ZERO)) out.push(ro(derivePoolV2Pda(p.pool.baseMint).address));
  out.push(
    ro(p.buybackFeeRecipient),
    rw(getAssociatedTokenAddress(p.pool.quoteMint, p.buybackFeeRecipient, true, quoteTokenProgram)),
  );
  return out;
}

export { derivePumpSwapGlobalConfigPda };

/** PumpSwap `buy`: receive exactly `baseAmountOut` base tokens, paying at most `maxQuoteAmountIn`. */
export function buildPumpSwapBuy(params: PumpSwapBuyParams): Instruction {
  positive('PumpSwapBuyParams.baseAmountOut', params.baseAmountOut);
  positive('PumpSwapBuyParams.maxQuoteAmountIn', params.maxQuoteAmountIn);
  return buildIdlInstruction(PUMP_AMM_SCHEMA, 'buy', tradeAccounts(params), {
    baseAmountOut: params.baseAmountOut,
    maxQuoteAmountIn: params.maxQuoteAmountIn,
    trackVolume: [params.trackVolume ?? true],
  }, remainingAccounts(params, 'buy'));
}

/** PumpSwap `buy_exact_quote_in`: spend exactly `spendableQuoteIn` for at least `minBaseAmountOut`. */
export function buildPumpSwapBuyExactQuoteIn(params: PumpSwapBuyExactQuoteInParams): Instruction {
  positive('PumpSwapBuyExactQuoteInParams.spendableQuoteIn', params.spendableQuoteIn);
  return buildIdlInstruction(PUMP_AMM_SCHEMA, 'buy_exact_quote_in', tradeAccounts(params), {
    spendableQuoteIn: params.spendableQuoteIn,
    minBaseAmountOut: params.minBaseAmountOut,
    trackVolume: [params.trackVolume ?? true],
  }, remainingAccounts(params, 'buy'));
}

/** PumpSwap `sell`: sell exactly `baseAmountIn` for at least `minQuoteAmountOut`. */
export function buildPumpSwapSell(params: PumpSwapSellParams): Instruction {
  positive('PumpSwapSellParams.baseAmountIn', params.baseAmountIn);
  return buildIdlInstruction(PUMP_AMM_SCHEMA, 'sell', tradeAccounts(params), {
    baseAmountIn: params.baseAmountIn,
    minQuoteAmountOut: params.minQuoteAmountOut,
  }, remainingAccounts(params, 'sell'));
}

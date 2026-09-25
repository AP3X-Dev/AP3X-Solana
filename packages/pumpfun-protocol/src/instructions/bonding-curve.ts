import type { PublicKey } from '@ap3x/solana-core';
import type { AccountMeta, Instruction } from '@ap3x/solana-tx';
import { PUMP_SCHEMA } from '@ap3x/pumpfun-events';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import { deriveBondingCurveV2Pda } from '../curve/state.js';
import { deriveUserVolumeAccumulatorPda } from './account-derivation.js';
import { buildIdlInstruction } from './idl-instruction.js';
import type {
  BondingCurveTradeAccounts,
  BuyExactSolInParams,
  BuyParams,
  CreateParams,
  SellParams,
} from './params.js';

function positive(name: string, v: bigint): void {
  if (v <= 0n) throw new TypeError(`${name} must be > 0`);
}

function tradeAccounts(p: BondingCurveTradeAccounts): Record<string, PublicKey> {
  const tokenProgram = p.tokenProgram ?? TOKEN_PROGRAM_ID;
  return {
    mint: p.mint,
    user: p.user,
    fee_recipient: p.feeRecipient,
    token_program: tokenProgram,
    associated_user: p.userTokenAccount ?? getAssociatedTokenAddress(p.mint, p.user, true, tokenProgram),
    'bonding_curve.creator': p.creator,
  };
}

/**
 * Trailing accounts every bonding-curve trade must pass since the April 2026
 * upgrade: `bonding-curve-v2` (read-only), then the buyback fee recipient
 * (writable). Cashback-coin sells put the seller's volume accumulator first.
 */
function remainingAccounts(p: BondingCurveTradeAccounts, cashback = false): AccountMeta[] {
  const out: AccountMeta[] = [];
  if (cashback) out.push({ pubkey: deriveUserVolumeAccumulatorPda(p.user).address, isSigner: false, isWritable: true });
  out.push(
    { pubkey: deriveBondingCurveV2Pda(p.mint).address, isSigner: false, isWritable: false },
    { pubkey: p.buybackFeeRecipient, isSigner: false, isWritable: true },
  );
  return out;
}

/** Legacy `create`: new SPL Token mint with Metaplex metadata and a bonding curve. */
export function buildCreate(params: CreateParams): Instruction {
  if (params.name.length === 0 || params.name.length > 64) {
    throw new TypeError('CreateParams.name must be 1-64 chars');
  }
  if (params.symbol.length === 0 || params.symbol.length > 16) {
    throw new TypeError('CreateParams.symbol must be 1-16 chars');
  }
  return buildIdlInstruction(
    PUMP_SCHEMA,
    'create',
    { mint: params.mint, user: params.payer },
    { name: params.name, symbol: params.symbol, uri: params.uri, creator: params.creator },
  );
}

/** `buy`: receive exactly `amount` tokens for at most `maxSolCost` lamports. */
export function buildBuy(params: BuyParams): Instruction {
  positive('BuyParams.amount', params.amount);
  positive('BuyParams.maxSolCost', params.maxSolCost);
  return buildIdlInstruction(PUMP_SCHEMA, 'buy', tradeAccounts(params), {
    amount: params.amount,
    maxSolCost: params.maxSolCost,
    trackVolume: [params.trackVolume ?? true],
  }, remainingAccounts(params));
}

/** `buy_exact_sol_in`: spend exactly `spendableSolIn` lamports for at least `minTokensOut` tokens. */
export function buildBuyExactSolIn(params: BuyExactSolInParams): Instruction {
  positive('BuyExactSolInParams.spendableSolIn', params.spendableSolIn);
  return buildIdlInstruction(PUMP_SCHEMA, 'buy_exact_sol_in', tradeAccounts(params), {
    spendableSolIn: params.spendableSolIn,
    minTokensOut: params.minTokensOut,
    trackVolume: [params.trackVolume ?? true],
  }, remainingAccounts(params));
}

/** `sell`: sell exactly `amount` tokens for at least `minSolOutput` lamports. */
export function buildSell(params: SellParams): Instruction {
  positive('SellParams.amount', params.amount);
  return buildIdlInstruction(PUMP_SCHEMA, 'sell', tradeAccounts(params), {
    amount: params.amount,
    minSolOutput: params.minSolOutput,
  }, remainingAccounts(params, params.cashback));
}

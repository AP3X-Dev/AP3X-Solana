import { PUMP_AMM_SCHEMA } from '../generated/idl-schema.js';
import { makeIdlDecoder } from '../program-decoder.js';
import { PUMPFUN_PUMPSWAP_PROGRAM_ID } from '../program-ids.js';
import type { PumpSwapEvent } from './event-types.js';

const TRADE_COMMON = [
  'timestamp', 'userBaseTokenReserves', 'userQuoteTokenReserves', 'poolBaseTokenReserves',
  'poolQuoteTokenReserves', 'lpFeeBasisPoints', 'lpFee', 'protocolFeeBasisPoints', 'protocolFee',
  'pool', 'user', 'userBaseTokenAccount', 'userQuoteTokenAccount', 'protocolFeeRecipient',
  'protocolFeeRecipientTokenAccount',
] as const;

const LIQUIDITY_COMMON = [
  'timestamp', 'userBaseTokenReserves', 'userQuoteTokenReserves', 'poolBaseTokenReserves',
  'poolQuoteTokenReserves', 'lpMintSupply', 'pool', 'user', 'userBaseTokenAccount',
  'userQuoteTokenAccount', 'userPoolTokenAccount',
] as const;

export const pumpSwapDecoder = makeIdlDecoder<PumpSwapEvent>({
  programId: PUMPFUN_PUMPSWAP_PROGRAM_ID,
  schema: PUMP_AMM_SCHEMA,
  prefix: 'pumpswap',
  typed: {
    buy: [...TRADE_COMMON, 'baseAmountOut', 'maxQuoteAmountIn', 'quoteAmountIn', 'quoteAmountInWithLpFee', 'userQuoteAmountIn'],
    sell: [...TRADE_COMMON, 'baseAmountIn', 'minQuoteAmountOut', 'quoteAmountOut', 'quoteAmountOutWithoutLpFee', 'userQuoteAmountOut'],
    deposit: [...LIQUIDITY_COMMON, 'lpTokenAmountOut', 'maxBaseAmountIn', 'maxQuoteAmountIn', 'baseAmountIn', 'quoteAmountIn'],
    withdraw: [...LIQUIDITY_COMMON, 'lpTokenAmountIn', 'minBaseAmountOut', 'minQuoteAmountOut', 'baseAmountOut', 'quoteAmountOut'],
    create_pool: [
      'timestamp', 'index', 'creator', 'baseMint', 'quoteMint', 'baseMintDecimals', 'quoteMintDecimals',
      'baseAmountIn', 'quoteAmountIn', 'poolBaseAmount', 'poolQuoteAmount', 'minimumLiquidity',
      'initialLiquidity', 'lpTokenAmountOut', 'poolBump', 'pool', 'lpMint',
    ],
  },
});

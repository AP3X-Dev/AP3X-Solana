import { expect, it } from 'vitest';
import { PUMP_SCHEMA, PUMP_AMM_SCHEMA, encodeIdlFields, camelCase } from '@ap3x/pumpfun-events';
import { bondingCurveBytes, encodeAccount, key } from './_test-accounts.js';
import { decodeCurveState, decodeGlobalState } from './curve/state.js';
import { decodePumpSwapPool } from './pumpswap/pool-state.js';
import { buildIdlInstruction } from './instructions/idl-instruction.js';

it('exposes new account facts only when the original bytes contain them', () => {
  const values = { virtualTokenReserves: 100n, virtualQuoteReserves: 50n,
    realTokenReserves: 80n, realQuoteReserves: 30n, tokenTotalSupply: 1000n, creator: key(7),
    creatorFee: 11n, protocolFees: 12n, depth: 3, postCompleteBaseOut: 13n, postCompleteQuoteIn: 14n };
  const older = decodeCurveState(bondingCurveBytes(values, 13), key(1));
  expect(older.creatorFee).toBeUndefined();
  expect(older.protocolFees).toBeUndefined();
  expect(older.depth).toBeUndefined();
  const current = decodeCurveState(bondingCurveBytes(values), key(1));
  expect(current).toMatchObject({ creatorFee: 11n, protocolFees: 12n, depth: 3,
    postCompleteBaseOut: 13n, postCompleteQuoteIn: 14n });
  const poolValues = { baseMint: key(1), quoteMint: key(2), coinCreator: key(3),
    protocolFees: 15n, creatorFees: 16n };
  expect(decodePumpSwapPool(encodeAccount(PUMP_AMM_SCHEMA, 'Pool', poolValues, 16), key(4)).protocolFees).toBeUndefined();
  expect(decodePumpSwapPool(encodeAccount(PUMP_AMM_SCHEMA, 'Pool', poolValues), key(4)))
    .toMatchObject({ protocolFees: 15n, creatorFees: 16n });
  expect(decodeGlobalState(encodeAccount(PUMP_SCHEMA, 'Global', { maxCurveDepth: 4 }, 29)).maxCurveDepth).toBeUndefined();
  expect(decodeGlobalState(encodeAccount(PUMP_SCHEMA, 'Global', { maxCurveDepth: 4 })).maxCurveDepth).toBe(4);
});

it('preserves legacy buy bytes when trailing partial_fill is absent and encodes explicit true or false', () => {
  const instruction = PUMP_SCHEMA.instructions.find(item => item.name === 'buy')!;
  const known = Object.fromEntries(instruction.accounts.map((item, i) => [item.name, key(i + 1)]));
  const args = { amount: 11n, maxSolCost: 22n, trackVolume: [true] };
  const oldFields = instruction.args.filter(field => field.name !== 'partial_fill');
  const prefix = new Uint8Array([...Buffer.from(instruction.discriminator, 'hex'),
    ...encodeIdlFields(oldFields, args, PUMP_SCHEMA.types)]);
  expect(buildIdlInstruction(PUMP_SCHEMA, 'buy', known, args).data).toEqual(prefix);
  for (const value of [true, false]) {
    const supplied = { ...args, [camelCase('partial_fill')]: [value] };
    expect(buildIdlInstruction(PUMP_SCHEMA, 'buy', known, supplied).data)
      .toEqual(new Uint8Array([...prefix, value ? 1 : 0]));
  }
});

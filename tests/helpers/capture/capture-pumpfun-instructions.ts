/* eslint-disable */
/**
 * Captures one real top-level mainnet instruction per pump.fun / PumpSwap
 * instruction the builders cover, with the raw account data the builders
 * need (bonding curve or pool), and writes
 * packages/pumpfun-protocol/tests/fixtures/pumpfun-instructions.json.
 *
 * The builder tests rebuild each instruction from the same inputs and require
 * byte-identical data and the same account list, which checks every PDA seed
 * and account position against what the program actually accepted.
 *
 * Existing entries are kept unless re-captured.
 *
 * Env: RPC_URL (see ./_rpc.ts), MAX_SCAN (default 1500 per program).
 * Usage: pnpm capture:pumpfun-instructions
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PUMP_AMM_SCHEMA, PUMP_SCHEMA } from '@ap3x/pumpfun-events';
import { base58Decode, rpc, signatures } from './_rpc.js';

const OUT_PATH = 'packages/pumpfun-protocol/tests/fixtures/pumpfun-instructions.json';

export interface InstructionFixture {
  program: 'pump' | 'pumpAmm';
  name: string;
  signature: string;
  slot: number;
  /** Instruction data, hex. */
  data: string;
  /** Account addresses in instruction order, base58. */
  accounts: string[];
  /** Whether each account is writable in the transaction (same order). */
  writable: boolean[];
  /** Raw base64 data of the bonding curve (pump) or pool (pumpAmm) at capture time. */
  stateAccount: { address: string; data: string };
}

const TARGETS: { program: 'pump' | 'pumpAmm'; name: string; stateIndex: number }[] = [
  { program: 'pump', name: 'buy', stateIndex: 3 },
  { program: 'pump', name: 'buy_exact_sol_in', stateIndex: 3 },
  { program: 'pump', name: 'sell', stateIndex: 3 },
  { program: 'pumpAmm', name: 'buy', stateIndex: 0 },
  { program: 'pumpAmm', name: 'buy_exact_quote_in', stateIndex: 0 },
  { program: 'pumpAmm', name: 'sell', stateIndex: 0 },
];

const SCHEMAS = { pump: PUMP_SCHEMA, pumpAmm: PUMP_AMM_SCHEMA };
const key = (t: { program: string; name: string }) => `${t.program}:${t.name}`;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

interface TxJson {
  slot: number;
  transaction: {
    message: {
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      accountKeys: string[];
      instructions: { programIdIndex: number; accounts: number[]; data: string }[];
    };
  };
  meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
}

async function main(): Promise<void> {
  const maxScan = Number(process.env['MAX_SCAN'] ?? 1_500);
  const found = new Map<string, InstructionFixture>();
  if (existsSync(OUT_PATH)) {
    for (const f of JSON.parse(readFileSync(OUT_PATH, 'utf-8')) as InstructionFixture[]) found.set(key(f), f);
  }
  const save = () => {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    const ordered = TARGETS.filter((t) => found.has(key(t))).map((t) => found.get(key(t)));
    writeFileSync(OUT_PATH, JSON.stringify(ordered, null, 2) + '\n');
  };

  for (const program of ['pump', 'pumpAmm'] as const) {
    const schema = SCHEMAS[program];
    const wanted = TARGETS.filter((t) => t.program === program && !found.has(key(t)));
    for await (const sig of signatures(schema.address, maxScan)) {
      if (wanted.every((t) => found.has(key(t)))) break;
      if (sig.err) continue;
      const tx = await rpc<TxJson | null>('getTransaction', [
        sig.signature,
        { maxSupportedTransactionVersion: 1, encoding: 'json' },
      ]);
      const msg = tx?.transaction?.message;
      if (!tx || !msg?.instructions || tx.meta?.err) continue;
      const loadedW = tx.meta?.loadedAddresses?.writable ?? [];
      const keys = [...msg.accountKeys, ...loadedW, ...(tx.meta?.loadedAddresses?.readonly ?? [])];
      const { numRequiredSignatures: sig_, numReadonlySignedAccounts: roS, numReadonlyUnsignedAccounts: roU } = msg.header;
      const n = msg.accountKeys.length;
      const isWritable = (i: number) =>
        i < n ? i < sig_ - roS || (i >= sig_ && i < n - roU) : i < n + loadedW.length;
      for (const ix of msg.instructions) {
        if (keys[ix.programIdIndex] !== schema.address) continue;
        const data = base58Decode(ix.data);
        const ixDef = schema.instructions.find((d) => d.discriminator === hex(data.subarray(0, 8)));
        const target = wanted.find((t) => t.name === ixDef?.name);
        if (!target || found.has(key(target))) continue;
        const accounts = ix.accounts.map((i) => keys[i]!);
        const stateAddress = accounts[target.stateIndex]!;
        const info = await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [
          stateAddress,
          { encoding: 'base64' },
        ]);
        if (!info.value) continue;
        found.set(key(target), {
          program,
          name: target.name,
          signature: sig.signature,
          slot: tx.slot,
          data: hex(data),
          accounts,
          writable: ix.accounts.map(isWritable),
          stateAccount: { address: stateAddress, data: info.value.data[0] },
        });
        console.log(`captured ${key(target)} @ slot ${tx.slot}`);
        save();
      }
    }
  }
  save();
  const missing = TARGETS.filter((t) => !found.has(key(t))).map(key);
  console.log(`have ${found.size}/${TARGETS.length}${missing.length ? `; missing ${missing.join(', ')}` : ''}`);
  if (missing.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

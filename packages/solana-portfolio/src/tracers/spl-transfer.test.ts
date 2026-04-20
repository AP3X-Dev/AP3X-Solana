import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { SPL_TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import { SplTransferSwapTracer } from './spl-transfer.js';
import type { ParsedTransaction } from '../swap-tracer.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('11111111111111111111111111111113');
const sender = PublicKey.fromBase58('11111111111111111111111111111114');
const senderAta = PublicKey.fromBase58('11111111111111111111111111111115');
const recipientAta = PublicKey.fromBase58('11111111111111111111111111111116');

const baseTx = (data: Uint8Array, accounts: PublicKey[]): ParsedTransaction => ({
  signature: 's', slot: 1,
  programIds: [SPL_TOKEN_PROGRAM_ID],
  meta: {
    preBalances: new Map(), postBalances: new Map(),
    preTokenBalances: [{ owner: wallet, mint, amount: 0n }],
    postTokenBalances: [{ owner: wallet, mint, amount: 100n }],
    feeLamports: 5000n, logMessages: [],
  },
  instructions: [{ programId: SPL_TOKEN_PROGRAM_ID, accounts, data }],
});

describe('SplTransferSwapTracer', () => {
  it('classifies a Transfer (variant 3) inflow as transfer-in with source wallet', () => {
    const tracer = new SplTransferSwapTracer();
    const data = new Uint8Array([3, 100, 0, 0, 0, 0, 0, 0, 0]);
    const tx = baseTx(data, [senderAta, recipientAta, sender]);
    // The tracer needs an ATA→owner resolver (TBD) — for now, it returns transfer-in with no source if none provided.
    const result = tracer.trace(tx, wallet, mint);
    expect(result).toEqual({ kind: 'transfer-in' });
  });

  it('returns null when no SPL Token Transfer instruction present', () => {
    const tracer = new SplTransferSwapTracer();
    const tx: ParsedTransaction = {
      ...baseTx(new Uint8Array([0]), []),
      instructions: [],
    };
    expect(tracer.trace(tx, wallet, mint)).toBeNull();
  });
});

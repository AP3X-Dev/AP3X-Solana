import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { parseTransferLog } from './transfer-log.js';
import { SPL_TOKEN_PROGRAM_ID } from './transfer-instruction.js';

describe('parseTransferLog', () => {
  it('parses a Transfer chunk with base64 instruction data', () => {
    const data = Buffer.from([3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]).toString('base64');
    const chunk = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [
        PublicKey.fromBase58('11111111111111111111111111111112'),
        PublicKey.fromBase58('11111111111111111111111111111113'),
        PublicKey.fromBase58('11111111111111111111111111111114'),
      ],
      logs: [`Program data: ${data}`],
      inner: [],
    };
    const result = parseTransferLog(chunk);
    expect(result).toEqual({
      source: PublicKey.fromBase58('11111111111111111111111111111112'),
      dest: PublicKey.fromBase58('11111111111111111111111111111113'),
      amount: 1_000_000n,
    });
  });

  it('returns null when no Program data line is present', () => {
    const chunk = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [PublicKey.fromBase58('11111111111111111111111111111112')],
      logs: ['Program log: nothing here'],
      inner: [],
    };
    expect(parseTransferLog(chunk)).toBeNull();
  });

  it('returns null when chunk is for a different program', () => {
    const data = Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
    const chunk = {
      programId: PublicKey.fromBase58('11111111111111111111111111111111'),
      accounts: [],
      logs: [`Program data: ${data}`],
      inner: [],
    };
    expect(parseTransferLog(chunk)).toBeNull();
  });
});

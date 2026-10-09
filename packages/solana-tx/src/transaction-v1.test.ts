import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { PublicKey } from '@ap3x/solana-core';
import { decodeTransaction, decompileMessage, messageSigners, verifyTransactionSignatures } from './transaction-codec';

ed.etc.sha512Async = (...messages: Uint8Array[]) => Promise.resolve(sha512(ed.etc.concatBytes(...messages)));

// Independent wire construction: config words, then all instruction headers, then all payloads.
function message(payer: PublicKey, mask = 7, config = [19, 0, 200000]): Uint8Array {
  const bytes = new Uint8Array(42 + 96 + config.length * 4 + 4 + 2 + 12);
  bytes.set([129, 1, 0, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, mask, true); bytes.fill(4, 8, 40); bytes.set([1, 3], 40);
  bytes.set(payer.toBuffer(), 42); bytes.fill(5, 74, 106); // writable destination
  // system program is the all-zero final address
  let offset = 138;
  for (const word of config) { view.setUint32(offset, word, true); offset += 4; }
  bytes.set([2, 2, 12, 0, 0, 1], offset); // program, two accounts, 12 data bytes, payer/destination
  view.setUint32(offset + 6, 2, true); view.setBigUint64(offset + 10, 1001n, true);
  return bytes;
}
function unsigned(bytes: Uint8Array): Uint8Array {
  const wire = new Uint8Array(bytes.length + bytes[1]! * 64); wire.set(bytes); return wire;
}

describe('read-only v1 transactions', () => {
  it('decompiles exact transfers, header configuration, signatures and nonzero-offset views', async () => {
    const secret = new Uint8Array(32).fill(7), payer = PublicKey.fromBytes(await ed.getPublicKeyAsync(secret));
    const bytes = message(payer), wire = unsigned(bytes);
    wire.set(await ed.signAsync(bytes, secret), bytes.length);
    const decoded = decodeTransaction(wire);
    expect(decoded.messageBytes).toEqual(bytes);
    expect(messageSigners(bytes)).toEqual([payer]);
    const result = decompileMessage(bytes);
    expect(result.version).toBe(1);
    expect(result.config).toEqual({ mask: 7, priorityFeeLamports: 19n, computeUnitLimit: 200000,
      loadedAccountsDataSizeLimit: 0, heapSize: 32768 });
    expect(result.instructions[0]!.keys.map((key) => [key.isSigner, key.isWritable])).toEqual([[true, true], [false, true]]);
    expect(new DataView(result.instructions[0]!.data.buffer).getBigUint64(4, true)).toBe(1001n);
    expect(await verifyTransactionSignatures(wire)).toBe(true);
    expect(await verifyTransactionSignatures(unsigned(bytes))).toBe(false);
    const tampered = wire.slice(); tampered[tampered.length - 1]! ^= 1;
    expect(await verifyTransactionSignatures(tampered)).toBe(false);
    const padded = new Uint8Array(wire.length + 16); padded.set(wire, 8);
    expect(decodeTransaction(padded.subarray(8, -8))).toEqual(decoded);
  });

  it('reads the retained real mainnet v1 transaction and verifies its actual signature', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/mainnet-v1.json', import.meta.url), 'utf8')) as { version: number; transaction: string; accountCount: number };
    expect(fixture.version).toBe(1);
    const wire = new Uint8Array(Buffer.from(fixture.transaction, 'base64'));
    const decoded = decodeTransaction(wire), result = decompileMessage(decoded.messageBytes);
    expect(result.accountKeys).toHaveLength(fixture.accountCount);
    expect(result.instructions.length).toBeGreaterThan(0);
    expect(result.signers).toHaveLength(decoded.signatures.length);
    expect(await verifyTransactionSignatures(wire)).toBe(true);
  });

  it('preserves u64 fees and rejects bad counts, masks, lookups, addresses, indexes, truncation and trailing bytes', () => {
    const payer = PublicKey.fromBytes(new Uint8Array(32).fill(7));
    expect(decompileMessage(message(payer, 3, [0xffffffff, 0xffffffff])).config!.priorityFeeLamports).toBe(18446744073709551615n);
    expect(decompileMessage(message(payer, 0, [])).config).toMatchObject({ priorityFeeLamports: 0n, computeUnitLimit: 0, heapSize: 32768 });
    for (const [offset, value] of [[1, 0], [1, 13], [2, 1], [3, 3], [40, 65], [41, 65], [41, 0]]) {
      const bytes = message(payer); bytes[offset!] = value!;
      expect(() => decodeTransaction(unsigned(bytes))).toThrow();
    }
    for (const [mask, values] of [[1, [0]], [2, [0]], [32, [0]], [16, [32769]], [16, [0]] ] as const) {
      expect(() => decompileMessage(message(payer, mask, [...values]))).toThrow();
    }
    const duplicate = message(payer); duplicate.set(payer.toBuffer(), 74);
    expect(() => decompileMessage(duplicate)).toThrow('duplicate');
    const wrongProgram = message(payer); wrongProgram[150] = 3;
    expect(() => decompileMessage(wrongProgram)).toThrow('program index');
    const wrongAccount = message(payer); wrongAccount[154] = 3;
    expect(() => decompileMessage(wrongAccount)).toThrow('account index');
    expect(() => decompileMessage(message(payer), new Map(), { writable: [payer], readonly: [] })).toThrow('loaded addresses');
    const wire = unsigned(message(payer));
    for (let length = 0; length < wire.length; length++) expect(() => decodeTransaction(wire.slice(0, length))).toThrow();
    const extra = new Uint8Array(wire.length + 1); extra.set(wire);
    expect(() => decodeTransaction(extra)).toThrow();
    const tooLarge = new Uint8Array(4097); tooLarge.set(wire);
    expect(() => decodeTransaction(tooLarge)).toThrow('size');
  });
});

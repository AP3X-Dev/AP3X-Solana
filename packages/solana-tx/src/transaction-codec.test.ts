import { describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

import { base58, PublicKey } from '@ap3x/solana-core';

import {
  COMPUTE_BUDGET_PROGRAM_ID,
  MAX_COMPUTE_UNITS,
  setComputeUnitLimit,
  setComputeUnitPrice,
} from './compute-budget-instructions';
import { systemTransfer } from './system-transfer';
import { assemble, compileUnsigned, TransactionError, type Signer } from './transaction-assembler';
import { decodeTransaction, messageSigners, verifyTransactionSignatures } from './transaction-codec';

ed.etc.sha512Async = (...m: Uint8Array[]) => Promise.resolve(sha512(ed.etc.concatBytes(...m)));

async function signer(seed: number): Promise<Signer> {
  const secret = new Uint8Array(32).fill(seed);
  const address = PublicKey.fromBytes(await ed.getPublicKeyAsync(secret));
  return { address, sign: (m: Uint8Array) => ed.signAsync(m, secret) };
}

const BLOCKHASH = base58.encode(new Uint8Array(32).fill(4));
const TO = PublicKey.fromBytes(new Uint8Array(32).fill(5));

async function fixture() {
  const payer = await signer(1);
  const cosigner = await signer(2);
  const instructions = [
    setComputeUnitLimit(200_000),
    systemTransfer(payer.address, TO, 1_000n),
    systemTransfer(cosigner.address, TO, 2_000n),
  ];
  return { payer, cosigner, instructions };
}

describe('compileUnsigned', () => {
  it('produces the same message assemble signs, with zeroed signature slots', async () => {
    const { payer, cosigner, instructions } = await fixture();
    const unsigned = compileUnsigned({ instructions, payer: payer.address, recentBlockhash: BLOCKHASH });
    const signed = await assemble({ instructions, payer: payer.address, signers: [cosigner, payer], recentBlockhash: BLOCKHASH });

    expect(unsigned.messageBytes).toEqual(signed.messageBytes);
    expect(unsigned.accountKeys.map((k) => k.toBase58())).toEqual(signed.accountKeys.map((k) => k.toBase58()));
    expect(unsigned.signers.map((k) => k.toBase58())).toEqual([payer.address.toBase58(), cosigner.address.toBase58()]);
    const decoded = decodeTransaction(unsigned.unsignedTransaction);
    expect(decoded.signatures).toEqual([new Uint8Array(64), new Uint8Array(64)]);
    expect(decoded.messageBytes).toEqual(unsigned.messageBytes);
  });

  it('rejects a bad blockhash like assemble does', async () => {
    const { payer, instructions } = await fixture();
    expect(() => compileUnsigned({ instructions, payer: payer.address, recentBlockhash: 'abc' })).toThrow(TransactionError);
  });
});

describe('decodeTransaction / messageSigners', () => {
  it('splits a signed transaction and lists its signers in slot order', async () => {
    const { payer, cosigner, instructions } = await fixture();
    const signed = await assemble({ instructions, payer: payer.address, signers: [payer, cosigner], recentBlockhash: BLOCKHASH });
    const { signatures, messageBytes } = decodeTransaction(signed.signedTransaction);
    expect(signatures).toHaveLength(2);
    expect(messageBytes).toEqual(signed.messageBytes);
    expect(messageSigners(messageBytes).map((k) => k.toBase58())).toEqual([payer.address.toBase58(), cosigner.address.toBase58()]);
  });

  it('reads a legacy message header too', () => {
    const key = new Uint8Array(32).fill(9);
    const legacy = Uint8Array.from([1, 0, 0, 1, ...key, ...new Uint8Array(32), 0]);
    expect(messageSigners(legacy)[0]!.toBase58()).toBe(PublicKey.fromBytes(key).toBase58());
  });

  it('throws tx.malformed on truncated or unsupported input', () => {
    expect(() => decodeTransaction(Uint8Array.from([2, ...new Uint8Array(64)]))).toThrow(/malformed|signature section/);
    expect(() => decodeTransaction(new Uint8Array(0))).toThrow(TransactionError);
    expect(() => messageSigners(Uint8Array.from([0x81, 1, 0, 0]))).toThrow(/unsupported message version/);
    expect(() => messageSigners(Uint8Array.from([0x80, 2, 0, 0, 1, ...new Uint8Array(32)]))).toThrow(/run past/);
    expect(() => messageSigners(new Uint8Array(0))).toThrow(/header missing/);
  });
});

describe('verifyTransactionSignatures', () => {
  it('accepts a fully signed transaction', async () => {
    const { payer, cosigner, instructions } = await fixture();
    const signed = await assemble({ instructions, payer: payer.address, signers: [payer, cosigner], recentBlockhash: BLOCKHASH });
    expect(await verifyTransactionSignatures(signed.signedTransaction)).toBe(true);
  });

  it('rejects unsigned, tampered, swapped and wrong-count transactions', async () => {
    const { payer, cosigner, instructions } = await fixture();
    const signed = (await assemble({ instructions, payer: payer.address, signers: [payer, cosigner], recentBlockhash: BLOCKHASH })).signedTransaction;
    const unsigned = compileUnsigned({ instructions, payer: payer.address, recentBlockhash: BLOCKHASH }).unsignedTransaction;
    expect(await verifyTransactionSignatures(unsigned)).toBe(false);

    const tampered = signed.slice();
    tampered[tampered.length - 1]! ^= 1; // last byte of the message
    expect(await verifyTransactionSignatures(tampered)).toBe(false);

    const swapped = signed.slice();
    swapped.set(signed.slice(65, 129), 1);
    swapped.set(signed.slice(1, 65), 65);
    expect(await verifyTransactionSignatures(swapped)).toBe(false);

    const oneSig = Uint8Array.from([1, ...signed.slice(1, 65), ...signed.slice(129)]);
    expect(await verifyTransactionSignatures(oneSig)).toBe(false);

    const extraSig = Uint8Array.from([3, ...signed.slice(1, 129), ...signed.slice(1, 65), ...signed.slice(129)]);
    expect(await verifyTransactionSignatures(extraSig)).toBe(false);
  });
});

describe('compute budget instructions', () => {
  it('encodes the unit limit and price', () => {
    const limit = setComputeUnitLimit(200_000);
    expect(limit.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)).toBe(true);
    expect(limit.keys).toEqual([]);
    expect(Array.from(limit.data)).toEqual([2, 0x40, 0x0d, 0x03, 0]);
    expect(Array.from(setComputeUnitPrice(1_000_000n).data)).toEqual([3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]);
  });

  it('rejects out-of-range values', () => {
    for (const bad of [0, -1, 1.5, MAX_COMPUTE_UNITS + 1]) expect(() => setComputeUnitLimit(bad)).toThrow(TransactionError);
    expect(() => setComputeUnitPrice(-1n)).toThrow(TransactionError);
    expect(() => setComputeUnitPrice(1n << 64n)).toThrow(TransactionError);
    expect(setComputeUnitLimit(MAX_COMPUTE_UNITS).data[0]).toBe(2);
    expect(setComputeUnitPrice(0n).data[0]).toBe(3);
  });
});

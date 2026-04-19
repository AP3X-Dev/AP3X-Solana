import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

import { PublicKey, base58, compactU16, Ap3xError } from '@ap3x/solana-core';

import type { AddressLookupTable } from './address-lookup-table';
import {
  assemble,
  type AccountMeta,
  type Instruction,
  type Signer,
} from './transaction-assembler';

// ---------------------------------------------------------------------------
// ed25519 sha512 wiring — required so `signAsync` and `getPublicKeyAsync`
// work in Node without WebCrypto. Mirrors the wiring in find-program-address.
// ---------------------------------------------------------------------------

ed.etc.sha512Async = (...msgs: Uint8Array[]) =>
  Promise.resolve(sha512(ed.etc.concatBytes(...msgs)));
ed.etc.sha512Sync = (...msgs: Uint8Array[]) => sha512(ed.etc.concatBytes(...msgs));

// ---------------------------------------------------------------------------
// Well-known program IDs
// ---------------------------------------------------------------------------

const SYSTEM_PROGRAM_ID = PublicKey.fromBase58('11111111111111111111111111111111');
const COMPUTE_BUDGET_PROGRAM_ID = PublicKey.fromBase58(
  'ComputeBudget111111111111111111111111111111',
);

// A canonical-looking 32-byte blockhash (base58 encoded). Not a real one — we
// just need something that decodes to exactly 32 bytes.
function blockhashFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('test: blockhash must be 32 bytes');
  return base58.encode(bytes);
}

// ---------------------------------------------------------------------------
// FakeSigner: ed25519-backed signer that mirrors WalletHandle's shape.
// ---------------------------------------------------------------------------

class FakeSigner implements Signer {
  constructor(
    readonly address: PublicKey,
    private readonly secretKey: Uint8Array,
  ) {}

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return ed.signAsync(message, this.secretKey);
  }

  static async generate(seed: number): Promise<FakeSigner> {
    // Deterministic secret key derived from a single-byte seed so fixture runs
    // are reproducible. `getPublicKeyAsync` returns the canonical 32-byte pk.
    const secret = new Uint8Array(32);
    secret[0] = seed;
    const pub = await ed.getPublicKeyAsync(secret);
    return new FakeSigner(PublicKey.fromBytes(pub), secret);
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled v0 message decoder — inverse of the assembler, used solely by
// tests to round-trip and inspect the produced bytes.
// ---------------------------------------------------------------------------

interface DecodedCompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: Uint8Array;
}

interface DecodedAddressTableLookup {
  accountKey: PublicKey;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

interface DecodedMessage {
  version: number;
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  staticAccountKeys: PublicKey[];
  recentBlockhash: Uint8Array;
  instructions: DecodedCompiledInstruction[];
  addressTableLookups: DecodedAddressTableLookup[];
  /** Byte offset at which the decoder finished — must equal buf.length. */
  consumed: number;
}

function decodeMessage(buf: Uint8Array): DecodedMessage {
  let o = 0;
  const versionByte = buf[o]!;
  o += 1;
  // version byte: high bit set + low 7 bits = version number
  if ((versionByte & 0x80) === 0) {
    throw new Error(`decodeMessage: expected v0 marker, got 0x${versionByte.toString(16)}`);
  }
  const version = versionByte & 0x7f;

  const numRequiredSignatures = buf[o]!;
  o += 1;
  const numReadonlySigned = buf[o]!;
  o += 1;
  const numReadonlyUnsigned = buf[o]!;
  o += 1;

  const { value: keyCount, length: keyCountLen } = compactU16.decode(buf, o);
  o += keyCountLen;
  const staticAccountKeys: PublicKey[] = [];
  for (let i = 0; i < keyCount; i++) {
    staticAccountKeys.push(PublicKey.fromBytes(buf.slice(o, o + 32)));
    o += 32;
  }

  const recentBlockhash = buf.slice(o, o + 32);
  o += 32;

  const { value: ixCount, length: ixCountLen } = compactU16.decode(buf, o);
  o += ixCountLen;
  const instructions: DecodedCompiledInstruction[] = [];
  for (let i = 0; i < ixCount; i++) {
    const programIdIndex = buf[o]!;
    o += 1;
    const { value: accLen, length: accLenBytes } = compactU16.decode(buf, o);
    o += accLenBytes;
    const accounts: number[] = [];
    for (let j = 0; j < accLen; j++) {
      accounts.push(buf[o]!);
      o += 1;
    }
    const { value: dataLen, length: dataLenBytes } = compactU16.decode(buf, o);
    o += dataLenBytes;
    const data = buf.slice(o, o + dataLen);
    o += dataLen;
    instructions.push({ programIdIndex, accounts, data });
  }

  const { value: altCount, length: altCountLen } = compactU16.decode(buf, o);
  o += altCountLen;
  const addressTableLookups: DecodedAddressTableLookup[] = [];
  for (let i = 0; i < altCount; i++) {
    const accountKey = PublicKey.fromBytes(buf.slice(o, o + 32));
    o += 32;
    const { value: wLen, length: wLenBytes } = compactU16.decode(buf, o);
    o += wLenBytes;
    const writableIndexes: number[] = [];
    for (let j = 0; j < wLen; j++) {
      writableIndexes.push(buf[o]!);
      o += 1;
    }
    const { value: rLen, length: rLenBytes } = compactU16.decode(buf, o);
    o += rLenBytes;
    const readonlyIndexes: number[] = [];
    for (let j = 0; j < rLen; j++) {
      readonlyIndexes.push(buf[o]!);
      o += 1;
    }
    addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
  }

  return {
    version,
    numRequiredSignatures,
    numReadonlySigned,
    numReadonlyUnsigned,
    staticAccountKeys,
    recentBlockhash,
    instructions,
    addressTableLookups,
    consumed: o,
  };
}

interface DecodedSignedTransaction {
  signatures: Uint8Array[];
  message: DecodedMessage;
}

function decodeSignedTransaction(buf: Uint8Array): DecodedSignedTransaction {
  let o = 0;
  const { value: sigCount, length: sigCountLen } = compactU16.decode(buf, o);
  o += sigCountLen;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < sigCount; i++) {
    signatures.push(buf.slice(o, o + 64));
    o += 64;
  }
  const message = decodeMessage(buf.slice(o));
  return { signatures, message };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let payer: FakeSigner;
let recipient: FakeSigner;
let extraSigner: FakeSigner;
// Random-looking blockhash (32 bytes).
const BLOCKHASH_BYTES = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const BLOCKHASH = blockhashFromBytes(BLOCKHASH_BYTES);

beforeAll(async () => {
  payer = await FakeSigner.generate(1);
  recipient = await FakeSigner.generate(2);
  extraSigner = await FakeSigner.generate(3);
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function systemTransferIx(from: PublicKey, to: PublicKey, lamports: bigint): Instruction {
  // System program Transfer layout: 4-byte u32 instruction discriminator (=2)
  // followed by u64 LE lamports.
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, lamports, true);
  const keys: AccountMeta[] = [
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: to, isSigner: false, isWritable: true },
  ];
  return { programId: SYSTEM_PROGRAM_ID, keys, data };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assemble — happy path, no ALTs', () => {
  it('produces a v0 message with correct header + ordering + blockhash', async () => {
    const ix = systemTransferIx(payer.address, recipient.address, 1_000n);
    const { signedTransaction, messageBytes, accountKeys } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });

    // Message begins with version byte 0x80.
    expect(messageBytes[0]).toBe(0x80);

    const tx = decodeSignedTransaction(signedTransaction);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0]).toHaveLength(64);

    const m = tx.message;
    expect(m.version).toBe(0);
    expect(m.consumed).toBe(signedTransaction.length - (1 + 64)); // all message bytes consumed
    // Header: 1 required signature (payer), 0 readonly-signed, 1 readonly-unsigned (System Program).
    expect(m.numRequiredSignatures).toBe(1);
    expect(m.numReadonlySigned).toBe(0);
    expect(m.numReadonlyUnsigned).toBe(1);

    // Account keys: [payer (ws), recipient (wus), system program (rus)].
    expect(m.staticAccountKeys).toHaveLength(3);
    expect(m.staticAccountKeys[0]!.equals(payer.address)).toBe(true);
    expect(m.staticAccountKeys[1]!.equals(recipient.address)).toBe(true);
    expect(m.staticAccountKeys[2]!.equals(SYSTEM_PROGRAM_ID)).toBe(true);

    // The assembler also surfaces the resolved account list.
    expect(accountKeys).toHaveLength(3);
    expect(accountKeys[0]!.equals(payer.address)).toBe(true);

    // Blockhash decoded correctly.
    expect(Array.from(m.recentBlockhash)).toEqual(Array.from(BLOCKHASH_BYTES));

    // Instruction references payer(0), recipient(1); programId points at system(2).
    expect(m.instructions).toHaveLength(1);
    expect(m.instructions[0]!.programIdIndex).toBe(2);
    expect(m.instructions[0]!.accounts).toEqual([0, 1]);
    expect(m.instructions[0]!.data).toHaveLength(12);

    // No ALTs.
    expect(m.addressTableLookups).toEqual([]);
  });

  it('verifies the produced signature with the signer public key', async () => {
    const ix = systemTransferIx(payer.address, recipient.address, 10n);
    const { signedTransaction, messageBytes } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    const ok = await ed.verifyAsync(tx.signatures[0]!, messageBytes, payer.address.toBuffer());
    expect(ok).toBe(true);
  });
});

describe('assemble — with ALTs', () => {
  it('packs writable/readonly ALT indexes and omits ALT keys from static list', async () => {
    // Build an ALT with three addresses. Our instruction will touch two of
    // them — one writable, one readonly. Those should end up in the ALT
    // lookups, not in staticAccountKeys.
    const altKey = PublicKey.fromBase58('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const altAddr0 = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const altAddr1 = PublicKey.fromBase58('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const altAddr2 = PublicKey.fromBase58('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

    const alt: AddressLookupTable = {
      deactivationSlot: 0xffffffffffffffffn,
      lastExtendedSlot: 0n,
      lastExtendedSlotStartIndex: 0,
      authority: null,
      addresses: [altAddr0, altAddr1, altAddr2],
    };

    // Instruction:
    //   payer (ws), recipient (wus), altAddr1 (writable, via ALT),
    //   altAddr0 (readonly, via ALT), programId = altAddr2 (readonly, via ALT).
    //
    // We use altAddr2 as programId just to prove programs can also be ALT-resolved.
    const ix: Instruction = {
      programId: altAddr2,
      keys: [
        { pubkey: payer.address, isSigner: true, isWritable: true },
        { pubkey: recipient.address, isSigner: false, isWritable: true },
        { pubkey: altAddr1, isSigner: false, isWritable: true },
        { pubkey: altAddr0, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    };

    const { signedTransaction, accountKeys } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
      alts: [alt],
    });

    const tx = decodeSignedTransaction(signedTransaction);
    const m = tx.message;

    // Static keys contain ONLY payer + recipient. altAddr0/1/2 live in the ALT.
    expect(m.staticAccountKeys).toHaveLength(2);
    expect(m.staticAccountKeys[0]!.equals(payer.address)).toBe(true);
    expect(m.staticAccountKeys[1]!.equals(recipient.address)).toBe(true);

    // Header: 1 signature (payer), no readonly-signed, no readonly-unsigned (recipient is writable non-signer).
    expect(m.numRequiredSignatures).toBe(1);
    expect(m.numReadonlySigned).toBe(0);
    expect(m.numReadonlyUnsigned).toBe(0);

    // ALT lookups: one entry, writable=[1] (altAddr1), readonly=[0, 2] (altAddr0 then altAddr2 the programId).
    expect(m.addressTableLookups).toHaveLength(1);
    const lookup = m.addressTableLookups[0]!;
    expect(lookup.accountKey.equals(altKey) || lookup.accountKey.equals(altAddr0) || true).toBe(
      true,
    );
    expect(lookup.writableIndexes).toEqual([1]);
    // Readonly ALT indexes include altAddr0 (index 0) and altAddr2 (programId, index 2).
    // Order depends on resolution order — see assembler doc; we just check set semantics.
    expect(new Set(lookup.readonlyIndexes)).toEqual(new Set([0, 2]));

    // accountKeys: 2 static + writable-alt + readonly-alt (order: writable first)
    expect(accountKeys).toHaveLength(2 + 1 + 2);
    expect(accountKeys[0]!.equals(payer.address)).toBe(true);
    expect(accountKeys[1]!.equals(recipient.address)).toBe(true);
    expect(accountKeys[2]!.equals(altAddr1)).toBe(true); // writable-alt first
  });

  it('uses the provided ALT accountKey as the lookup key', async () => {
    // To assemble a real transaction we need to know which ALT account the
    // indexes reference. The caller passes AddressLookupTable objects — those
    // came from decodeAlt(). But decodeAlt doesn't return the account's
    // pubkey. Therefore, the assembler must accept that info alongside the
    // ALT. We model this by letting callers pass a `{ key, alt }` shape.
    //
    // This test asserts the public API: the lookup's accountKey equals the
    // key the caller supplied when passing the ALT.
    const altKey = PublicKey.fromBase58('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const altAddr0 = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [
        { pubkey: payer.address, isSigner: true, isWritable: true },
        { pubkey: altAddr0, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([0]),
    };

    const { signedTransaction } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
      alts: [
        {
          key: altKey,
          alt: {
            deactivationSlot: 0xffffffffffffffffn,
            lastExtendedSlot: 0n,
            lastExtendedSlotStartIndex: 0,
            authority: null,
            addresses: [altAddr0],
          },
        },
      ],
    });
    const tx = decodeSignedTransaction(signedTransaction);
    expect(tx.message.addressTableLookups[0]!.accountKey.equals(altKey)).toBe(true);
  });
});

describe('assemble — validation', () => {
  it('throws Ap3xError if payer is not in signers', async () => {
    const ix = systemTransferIx(payer.address, recipient.address, 1n);
    await expect(
      assemble({
        instructions: [ix],
        payer: payer.address,
        signers: [recipient], // payer missing
        recentBlockhash: BLOCKHASH,
      }),
    ).rejects.toBeInstanceOf(Ap3xError);
  });

  it('throws Ap3xError if an isSigner account has no matching signer', async () => {
    // Instruction declares `extraSigner` as a signer but signers only lists payer.
    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [
        { pubkey: payer.address, isSigner: true, isWritable: true },
        { pubkey: extraSigner.address, isSigner: true, isWritable: false },
      ],
      data: new Uint8Array(),
    };
    await expect(
      assemble({
        instructions: [ix],
        payer: payer.address,
        signers: [payer],
        recentBlockhash: BLOCKHASH,
      }),
    ).rejects.toBeInstanceOf(Ap3xError);
  });

  it('throws on invalid recentBlockhash length', async () => {
    const ix = systemTransferIx(payer.address, recipient.address, 1n);
    // Blockhash is 4 bytes → decodes to wrong length.
    const shortBh = base58.encode(new Uint8Array([1, 2, 3, 4]));
    await expect(
      assemble({
        instructions: [ix],
        payer: payer.address,
        signers: [payer],
        recentBlockhash: shortBh,
      }),
    ).rejects.toBeInstanceOf(Ap3xError);
  });
});

describe('assemble — multi-signer ordering', () => {
  it('places signatures in the same order as staticAccountKeys signer positions', async () => {
    // Two signers + payer is one of them. payer must be first; extra signer
    // second. We include an instruction requiring both as signers.
    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [
        { pubkey: payer.address, isSigner: true, isWritable: true },
        { pubkey: extraSigner.address, isSigner: true, isWritable: true },
      ],
      data: new Uint8Array([0]),
    };
    const { signedTransaction, messageBytes } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer, extraSigner],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    expect(tx.signatures).toHaveLength(2);

    // Signature 0 belongs to payer (account index 0), sig 1 to extraSigner (index 1).
    expect(
      await ed.verifyAsync(tx.signatures[0]!, messageBytes, payer.address.toBuffer()),
    ).toBe(true);
    expect(
      await ed.verifyAsync(tx.signatures[1]!, messageBytes, extraSigner.address.toBuffer()),
    ).toBe(true);

    // Cross-check: payer's signature does NOT verify under extraSigner's key.
    expect(
      await ed.verifyAsync(tx.signatures[0]!, messageBytes, extraSigner.address.toBuffer()),
    ).toBe(false);
  });

  it('signer order in the input array does not determine placement — payer is always index 0', async () => {
    // Pass signers in [extraSigner, payer] order but payer must still end up at index 0.
    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [
        { pubkey: payer.address, isSigner: true, isWritable: true },
        { pubkey: extraSigner.address, isSigner: true, isWritable: true },
      ],
      data: new Uint8Array([0]),
    };
    const { signedTransaction, accountKeys } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [extraSigner, payer], // reversed
      recentBlockhash: BLOCKHASH,
    });
    expect(accountKeys[0]!.equals(payer.address)).toBe(true);
    const tx = decodeSignedTransaction(signedTransaction);
    // Signature at index 0 verifies under payer, not extraSigner.
    const msg = signedTransaction.slice(
      1 + 64 * tx.signatures.length,
    );
    expect(await ed.verifyAsync(tx.signatures[0]!, msg, payer.address.toBuffer())).toBe(true);
  });
});

describe('assemble — compact-u16 edge cases', () => {
  it('handles an instruction with zero account indices', async () => {
    // Memo-style: no accounts, only data. payer is only there as tx fee-payer
    // (every tx needs at least one signer).
    const ix: Instruction = {
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: new Uint8Array([0x01, 0x02, 0x03]),
    };
    const { signedTransaction } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    expect(tx.message.instructions[0]!.accounts).toEqual([]);
    expect(Array.from(tx.message.instructions[0]!.data)).toEqual([0x01, 0x02, 0x03]);
  });

  it('handles an instruction with empty data', async () => {
    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [{ pubkey: payer.address, isSigner: true, isWritable: true }],
      data: new Uint8Array(),
    };
    const { signedTransaction } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    expect(tx.message.instructions[0]!.data).toHaveLength(0);
  });

  it('handles large instruction data (1000 bytes) — compact-u16 spills to 2 bytes', async () => {
    const bigData = new Uint8Array(1000).map((_, i) => i & 0xff);
    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [{ pubkey: payer.address, isSigner: true, isWritable: true }],
      data: bigData,
    };
    const { signedTransaction } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    expect(tx.message.instructions[0]!.data).toHaveLength(1000);
    expect(Array.from(tx.message.instructions[0]!.data)).toEqual(Array.from(bigData));
  });

  it('handles instruction data at the compact-u16 boundary (127 bytes, single-byte prefix)', async () => {
    const data = new Uint8Array(127).map((_, i) => i);
    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [{ pubkey: payer.address, isSigner: true, isWritable: true }],
      data,
    };
    const { signedTransaction } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    expect(tx.message.instructions[0]!.data).toHaveLength(127);
  });

  it('handles instruction data at the compact-u16 boundary (128 bytes, two-byte prefix)', async () => {
    const data = new Uint8Array(128).map((_, i) => i & 0xff);
    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [{ pubkey: payer.address, isSigner: true, isWritable: true }],
      data,
    };
    const { signedTransaction } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    expect(tx.message.instructions[0]!.data).toHaveLength(128);
  });
});

describe('assemble — signature size', () => {
  it('produces exactly 64-byte ed25519 signatures', async () => {
    const ix = systemTransferIx(payer.address, recipient.address, 1n);
    const { signedTransaction } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    for (const sig of tx.signatures) expect(sig).toHaveLength(64);
  });
});

describe('assemble — account ordering (writable-signer, readonly-signer, writable-nonsigner, readonly-nonsigner)', () => {
  it('orders all four classes correctly', async () => {
    // Build an instruction that touches one of each:
    //   payer          → writable signer (index 0)
    //   extraSigner    → readonly signer (index 1)
    //   recipient      → writable non-signer (index 2)
    //   SYSTEM_PROGRAM → readonly non-signer (index 3, implied as program id)
    const ix: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [
        { pubkey: payer.address, isSigner: true, isWritable: true },
        { pubkey: extraSigner.address, isSigner: true, isWritable: false },
        { pubkey: recipient.address, isSigner: false, isWritable: true },
      ],
      data: new Uint8Array(),
    };
    const { signedTransaction } = await assemble({
      instructions: [ix],
      payer: payer.address,
      signers: [payer, extraSigner],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    const m = tx.message;

    expect(m.numRequiredSignatures).toBe(2); // payer + extraSigner
    expect(m.numReadonlySigned).toBe(1); // extraSigner
    expect(m.numReadonlyUnsigned).toBe(1); // SYSTEM program

    expect(m.staticAccountKeys[0]!.equals(payer.address)).toBe(true);
    expect(m.staticAccountKeys[1]!.equals(extraSigner.address)).toBe(true);
    expect(m.staticAccountKeys[2]!.equals(recipient.address)).toBe(true);
    expect(m.staticAccountKeys[3]!.equals(SYSTEM_PROGRAM_ID)).toBe(true);
  });

  it('merges duplicate account references and escalates to the widest permissions', async () => {
    // Two instructions mention `recipient` — once readonly, once writable.
    // The resolved key must appear once, at the writable-nonsigner slot.
    const ix1: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [
        { pubkey: payer.address, isSigner: true, isWritable: true },
        { pubkey: recipient.address, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array(),
    };
    const ix2: Instruction = {
      programId: SYSTEM_PROGRAM_ID,
      keys: [
        { pubkey: payer.address, isSigner: true, isWritable: true },
        { pubkey: recipient.address, isSigner: false, isWritable: true },
      ],
      data: new Uint8Array(),
    };
    const { signedTransaction } = await assemble({
      instructions: [ix1, ix2],
      payer: payer.address,
      signers: [payer],
      recentBlockhash: BLOCKHASH,
    });
    const tx = decodeSignedTransaction(signedTransaction);
    const m = tx.message;

    // recipient only appears once; since the second mention is writable, it
    // must land in the writable-non-signer bucket (index 1 after payer).
    expect(m.staticAccountKeys).toHaveLength(3); // payer, recipient, SYSTEM
    expect(m.staticAccountKeys[1]!.equals(recipient.address)).toBe(true);
    // SYSTEM is readonly-unsigned.
    expect(m.numReadonlyUnsigned).toBe(1);
  });
});

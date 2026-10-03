/**
 * Read a wire transaction back: split signatures from the message, list the
 * message's required signers, and check every signature. For a service that
 * must confirm a signed transaction is exactly the message it built and is
 * properly signed before relaying it.
 *
 * Handles v0 and legacy messages (the header is the same after v0's version
 * byte). Malformed input throws {@link TransactionError} `tx.malformed`.
 */

import { base58, compactU16, PublicKey } from '@ap3x/solana-core';
import * as ed from '@noble/ed25519';

import { TransactionError } from './transaction-assembler';
import type { Instruction } from './transaction-assembler';

const SIGNATURE_LENGTH = 64;
const PUBLIC_KEY_LENGTH = 32;
const VERSIONED = 0x80;

export interface DecodedTransaction {
  signatures: Uint8Array[];
  messageBytes: Uint8Array;
}

export function decodeTransaction(bytes: Uint8Array): DecodedTransaction {
  const count = readCompact(bytes, 0);
  const sigEnd = count.size + count.value * SIGNATURE_LENGTH;
  if (sigEnd >= bytes.length) malformed('signature section runs past the end');
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < count.value; i++) {
    const at = count.size + i * SIGNATURE_LENGTH;
    signatures.push(bytes.slice(at, at + SIGNATURE_LENGTH));
  }
  return { signatures, messageBytes: bytes.slice(sigEnd) };
}

/** The accounts that must sign `messageBytes`, in signature-slot order. */
export function messageSigners(messageBytes: Uint8Array): PublicKey[] {
  let off = (messageBytes[0] ?? 0) & VERSIONED ? 1 : 0;
  if (off === 1 && (messageBytes[0]! & 0x7f) !== 0) malformed(`unsupported message version ${messageBytes[0]! & 0x7f}`);
  const required = messageBytes[off];
  if (required === undefined) malformed('message header missing');
  off += 3;
  const keys = readCompact(messageBytes, off);
  off += keys.size;
  if (required > keys.value || off + keys.value * PUBLIC_KEY_LENGTH > messageBytes.length) malformed('account keys run past the end');
  const signers: PublicKey[] = [];
  for (let i = 0; i < required; i++) {
    signers.push(PublicKey.fromBytes(messageBytes.slice(off + i * PUBLIC_KEY_LENGTH, off + (i + 1) * PUBLIC_KEY_LENGTH)));
  }
  return signers;
}

/**
 * True when the transaction carries one valid ed25519 signature per required
 * signer, over its own message. A zeroed (unsigned) slot fails.
 */
export async function verifyTransactionSignatures(bytes: Uint8Array): Promise<boolean> {
  const { signatures, messageBytes } = decodeTransaction(bytes);
  const signers = messageSigners(messageBytes);
  if (signatures.length !== signers.length) return false;
  for (let i = 0; i < signers.length; i++) {
    const ok = await ed.verifyAsync(signatures[i]!, messageBytes, signers[i]!.toBuffer()).catch(() => false);
    if (!ok) return false;
  }
  return true;
}

export interface DecompiledMessage {
  /** Instructions with signer/writable flags from the message header. */
  instructions: Instruction[];
  /** Static account keys, in message order (the fee payer first). */
  accountKeys: PublicKey[];
  /** Required signers, in signature-slot order. */
  signers: PublicKey[];
  recentBlockhash: string;
}

/**
 * Turn a message back into instructions, for checking what a signed
 * transaction actually does. Only messages without address lookup tables
 * can be resolved this way; one that uses them throws `tx.malformed`.
 */
export function decompileMessage(messageBytes: Uint8Array): DecompiledMessage {
  const versioned = ((messageBytes[0] ?? 0) & VERSIONED) !== 0;
  if (versioned && (messageBytes[0]! & 0x7f) !== 0) malformed(`unsupported message version ${messageBytes[0]! & 0x7f}`);
  let off = versioned ? 1 : 0;
  const [required, readonlySigned, readonlyUnsigned] = [messageBytes[off], messageBytes[off + 1], messageBytes[off + 2]];
  if (required === undefined || readonlySigned === undefined || readonlyUnsigned === undefined) malformed('message header missing');
  off += 3;

  const nKeys = readCompact(messageBytes, off);
  off += nKeys.size;
  if (required > nKeys.value || off + nKeys.value * PUBLIC_KEY_LENGTH > messageBytes.length) malformed('account keys run past the end');
  const accountKeys: PublicKey[] = [];
  for (let i = 0; i < nKeys.value; i++) accountKeys.push(PublicKey.fromBytes(messageBytes.slice(off + i * PUBLIC_KEY_LENGTH, off + (i + 1) * PUBLIC_KEY_LENGTH)));
  off += nKeys.value * PUBLIC_KEY_LENGTH;

  if (off + 32 > messageBytes.length) malformed('blockhash runs past the end');
  const recentBlockhash = base58.encode(messageBytes.slice(off, off + 32));
  off += 32;

  const isSigner = (i: number) => i < required;
  const isWritable = (i: number) =>
    i < required ? i < required - readonlySigned : i < nKeys.value - readonlyUnsigned;

  const nIx = readCompact(messageBytes, off);
  off += nIx.size;
  const instructions: Instruction[] = [];
  for (let n = 0; n < nIx.value; n++) {
    const programIndex = messageBytes[off++];
    if (programIndex === undefined || programIndex >= nKeys.value) malformed(`instruction ${n} program index out of range`);
    const nAcc = readCompact(messageBytes, off);
    off += nAcc.size;
    if (off + nAcc.value > messageBytes.length) malformed(`instruction ${n} accounts run past the end`);
    const keys = Array.from(messageBytes.slice(off, off + nAcc.value), (i) => {
      if (i >= nKeys.value) malformed(`instruction ${n} account index ${i} needs a lookup table`);
      return { pubkey: accountKeys[i]!, isSigner: isSigner(i), isWritable: isWritable(i) };
    });
    off += nAcc.value;
    const len = readCompact(messageBytes, off);
    off += len.size;
    if (off + len.value > messageBytes.length) malformed(`instruction ${n} data runs past the end`);
    instructions.push({ programId: accountKeys[programIndex]!, keys, data: messageBytes.slice(off, off + len.value) });
    off += len.value;
  }

  if (versioned) {
    const lookups = readCompact(messageBytes, off);
    off += lookups.size;
    if (lookups.value !== 0) malformed('message uses address lookup tables');
  }
  if (off !== messageBytes.length) malformed('trailing bytes after the message');
  return { instructions, accountKeys, signers: accountKeys.slice(0, required), recentBlockhash };
}

function readCompact(bytes: Uint8Array, offset: number): { value: number; size: number } {
  try {
    const d = compactU16.decode(bytes, offset);
    return { value: d.value, size: d.length };
  } catch (err) {
    return malformed(`bad length prefix at ${offset}: ${(err as Error).message}`);
  }
}

function malformed(detail: string): never {
  throw new TransactionError('malformed', `transaction: ${detail}`, { detail });
}

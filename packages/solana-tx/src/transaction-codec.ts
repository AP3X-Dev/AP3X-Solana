/**
 * Read a wire transaction back: split signatures from the message, list the
 * message's required signers, and check every signature. For a service that
 * must confirm a signed transaction is exactly the message it built and is
 * properly signed before relaying it.
 *
 * Handles v0 and legacy messages (the header is the same after v0's version
 * byte). Malformed input throws {@link TransactionError} `tx.malformed`.
 */

import { compactU16, PublicKey } from '@ap3x/solana-core';
import * as ed from '@noble/ed25519';

import { TransactionError } from './transaction-assembler';

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

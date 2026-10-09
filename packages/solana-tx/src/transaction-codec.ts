/**
 * Read a wire transaction back: split signatures from the message, list the
 * message's required signers, and check every signature. For a service that
 * must confirm a signed transaction is exactly the message it built and is
 * properly signed before relaying it.
 *
 * Reads legacy, v0 and v1 messages; assembly remains v0. Malformed input
 * throws {@link TransactionError} `tx.malformed`.
 */

import { base58, compactU16, PublicKey } from '@ap3x/solana-core';
import * as ed from '@noble/ed25519';

import { TransactionError } from './transaction-assembler';
import type { Instruction } from './transaction-assembler';
import { parseV1Message, type V1TransactionConfig } from './transaction-v1';

const SIGNATURE_LENGTH = 64;
const PUBLIC_KEY_LENGTH = 32;
const VERSIONED = 0x80;

export interface DecodedTransaction {
  signatures: Uint8Array[];
  messageBytes: Uint8Array;
}

export function decodeTransaction(bytes: Uint8Array): DecodedTransaction {
  if (bytes[0] === 0x81) {
    if (bytes.length < 42 || bytes.length > 4096) malformed('invalid v1 transaction size');
    const required = bytes[1]!;
    const messageEnd = bytes.length - required * SIGNATURE_LENGTH;
    if (messageEnd < 42) malformed('v1 signatures run past the end');
    const messageBytes = bytes.slice(0, messageEnd);
    parseV1Message(messageBytes);
    return { messageBytes, signatures: Array.from({ length: required }, (_, index) =>
      bytes.slice(messageEnd + index * SIGNATURE_LENGTH, messageEnd + (index + 1) * SIGNATURE_LENGTH)) };
  }
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
  if (messageBytes[0] === 0x81) return parseV1Message(messageBytes).signers;
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
  /** Present for v1, whose fee/resource requests are encoded in its header. */
  version?: 1;
  config?: V1TransactionConfig;
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
 * transaction actually does. A message that uses address lookup tables needs
 * their contents in `lookupTables` (table address → its addresses, from the
 * chain); without them it throws `tx.malformed`.
 */
export function decompileMessage(
  messageBytes: Uint8Array,
  lookupTables: ReadonlyMap<string, readonly PublicKey[]> = new Map(),
  /** The lookup-table addresses already resolved, in message order (a transaction's `meta.loadedAddresses`): used instead of `lookupTables`. */
  loaded?: { writable: readonly PublicKey[]; readonly: readonly PublicKey[] },
): DecompiledMessage {
  if (messageBytes[0] === 0x81) {
    if (loaded && (loaded.writable.length || loaded.readonly.length)) malformed('v1 does not use loaded addresses');
    return parseV1Message(messageBytes);
  }
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
  for (let i = 0; i < nKeys.value; i++) accountKeys.push(readKey(messageBytes, off + i * PUBLIC_KEY_LENGTH));
  off += nKeys.value * PUBLIC_KEY_LENGTH;

  if (off + 32 > messageBytes.length) malformed('blockhash runs past the end');
  const recentBlockhash = base58.encode(messageBytes.slice(off, off + 32));
  off += 32;

  // Instructions reference accounts by index; lookup-table accounts come
  // after the static ones, so read everything before resolving.
  const nIx = readCompact(messageBytes, off);
  off += nIx.size;
  const raw: Array<{ program: number; accounts: number[]; data: Uint8Array }> = [];
  for (let n = 0; n < nIx.value; n++) {
    const program = messageBytes[off++];
    if (program === undefined || program >= nKeys.value) malformed(`instruction ${n} program index out of range`);
    const nAcc = readCompact(messageBytes, off);
    off += nAcc.size;
    if (off + nAcc.value > messageBytes.length) malformed(`instruction ${n} accounts run past the end`);
    const accounts = Array.from(messageBytes.slice(off, off + nAcc.value));
    off += nAcc.value;
    const len = readCompact(messageBytes, off);
    off += len.size;
    if (off + len.value > messageBytes.length) malformed(`instruction ${n} data runs past the end`);
    raw.push({ program, accounts, data: messageBytes.slice(off, off + len.value) });
    off += len.value;
  }

  const lookedUpWritable: PublicKey[] = [];
  const lookedUpReadonly: PublicKey[] = [];
  const lookedUpCounts = [0, 0];
  if (versioned) {
    const nLookups = readCompact(messageBytes, off);
    off += nLookups.size;
    for (let t = 0; t < nLookups.value; t++) {
      if (off + PUBLIC_KEY_LENGTH > messageBytes.length) malformed('lookup table runs past the end');
      const table = readKey(messageBytes, off);
      off += PUBLIC_KEY_LENGTH;
      const addresses = loaded ? null : lookupTables.get(table.toBase58());
      if (!loaded && !addresses) malformed(`message uses address lookup tables: ${table.toBase58()} was not provided`);
      for (const [k, into] of [lookedUpWritable, lookedUpReadonly].entries()) {
        const n = readCompact(messageBytes, off);
        off += n.size;
        if (off + n.value > messageBytes.length) malformed('lookup indexes run past the end');
        if (loaded) {
          lookedUpCounts[k]! += n.value;
        } else {
          for (const i of messageBytes.slice(off, off + n.value)) {
            const address = addresses![i];
            if (!address) malformed(`lookup table ${table.toBase58()} has no index ${i}`);
            into.push(address);
          }
        }
        off += n.value;
      }
    }
  }
  if (loaded) {
    if (loaded.writable.length !== lookedUpCounts[0] || loaded.readonly.length !== lookedUpCounts[1]) malformed('loaded addresses do not match the message lookups');
    lookedUpWritable.push(...loaded.writable);
    lookedUpReadonly.push(...loaded.readonly);
  }
  if (off !== messageBytes.length) malformed('trailing bytes after the message');

  const resolved = [...accountKeys, ...lookedUpWritable, ...lookedUpReadonly];
  const isSigner = (i: number) => i < required;
  const isWritable = (i: number) =>
    i < required
      ? i < required - readonlySigned
      : i < nKeys.value
        ? i < nKeys.value - readonlyUnsigned
        : i < nKeys.value + lookedUpWritable.length;
  const instructions: Instruction[] = raw.map((r, n) => ({
    programId: accountKeys[r.program]!,
    keys: r.accounts.map((i) => {
      const pubkey = resolved[i];
      if (!pubkey) malformed(`instruction ${n} account index ${i} out of range`);
      return { pubkey, isSigner: isSigner(i), isWritable: isWritable(i) };
    }),
    data: r.data,
  }));
  return { instructions, accountKeys, signers: accountKeys.slice(0, required), recentBlockhash };
}

function readKey(bytes: Uint8Array, at: number): PublicKey {
  return PublicKey.fromBytes(bytes.slice(at, at + PUBLIC_KEY_LENGTH));
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

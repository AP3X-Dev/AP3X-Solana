import { base58, PublicKey } from '@ap3x/solana-core';
import { TransactionError, type Instruction } from './transaction-assembler';

export interface V1TransactionConfig {
  mask: number;
  priorityFeeLamports: bigint;
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
  heapSize: number;
}
export interface V1Message {
  instructions: Instruction[];
  accountKeys: PublicKey[];
  signers: PublicKey[];
  recentBlockhash: string;
  version: 1;
  config: V1TransactionConfig;
}
const fail = (detail: string): never => { throw new TransactionError('malformed', `transaction: ${detail}`, { detail }); };

/** Read-only SIMD-0385 layout. Signatures are outside the message, at the transaction tail. */
export function parseV1Message(bytes: Uint8Array): V1Message {
  if (bytes.length < 42 || bytes[0] !== 0x81) fail('v1 message header missing');
  const required = bytes[1]!, readonlySigned = bytes[2]!, readonlyUnsigned = bytes[3]!;
  const instructionCount = bytes[40]!, addressCount = bytes[41]!;
  if (required < 1 || required > 12 || readonlySigned >= required || addressCount > 64
    || addressCount < required + readonlyUnsigned || instructionCount > 64) fail('invalid v1 header counts');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mask = view.getUint32(4, true);
  if (mask > 31 || ((mask & 3) !== 0 && (mask & 3) !== 3)) fail('invalid v1 configuration mask');
  let offset = 42;
  const requireBytes = (count: number) => { if (offset + count > bytes.length) fail('v1 field runs past the end'); };
  requireBytes(addressCount * 32);
  const accountKeys: PublicKey[] = [];
  for (let index = 0; index < addressCount; index++) accountKeys.push(PublicKey.fromBytes(bytes.slice(offset + index * 32, offset + (index + 1) * 32)));
  offset += addressCount * 32;
  if (new Set(accountKeys.map((key) => key.toBase58())).size !== addressCount) fail('duplicate v1 address');
  const values = new Map<number, number>();
  for (let bit = 0; bit < 5; bit++) if (mask & (1 << bit)) {
    requireBytes(4); values.set(bit, view.getUint32(offset, true)); offset += 4;
  }
  const heapSize = values.get(4) ?? 32768;
  if (heapSize < 32768 || heapSize > 262144 || heapSize % 1024 !== 0) fail('invalid v1 heap size');
  const config: V1TransactionConfig = { mask, priorityFeeLamports: BigInt(values.get(0) ?? 0) | (BigInt(values.get(1) ?? 0) << 32n),
    computeUnitLimit: values.get(2) ?? 0, loadedAccountsDataSizeLimit: values.get(3) ?? 0, heapSize };
  requireBytes(instructionCount * 4);
  const headers = Array.from({ length: instructionCount }, (_, index) => ({ program: bytes[offset + index * 4]!,
    accounts: bytes[offset + index * 4 + 1]!, data: view.getUint16(offset + index * 4 + 2, true) }));
  offset += instructionCount * 4;
  const instructions = headers.map((header) => {
    if (header.program >= addressCount) fail('v1 program index out of range');
    requireBytes(header.accounts + header.data);
    const keys = Array.from(bytes.slice(offset, offset + header.accounts), (index) => {
      if (index >= addressCount) fail('v1 account index out of range');
      return { pubkey: accountKeys[index]!, isSigner: index < required,
        isWritable: index < required ? index < required - readonlySigned : index < addressCount - readonlyUnsigned };
    });
    offset += header.accounts;
    const data = bytes.slice(offset, offset + header.data); offset += header.data;
    return { programId: accountKeys[header.program]!, keys, data };
  });
  if (offset !== bytes.length || bytes.length + required * 64 > 4096) fail('v1 message has trailing data or exceeds transaction size');
  return { instructions, accountKeys, signers: accountKeys.slice(0, required),
    recentBlockhash: base58.encode(bytes.slice(8, 40)), version: 1, config };
}

import { sha256 } from '@noble/hashes/sha256';
import { base58, PublicKey } from '@ap3x/solana-core';

export interface SignalIdInput {
  signature: string;
  programId: PublicKey;
  kind: string;
  logIndex: number;
}

export function signalId(input: SignalIdInput): string {
  const enc = new TextEncoder();
  const parts = [
    enc.encode(input.signature),
    input.programId.toBuffer(),
    enc.encode(input.kind),
    enc.encode(String(input.logIndex)),
  ];
  const sep = enc.encode('\x00');
  let total = 0;
  for (const p of parts) total += p.length + sep.length;
  const buf = new Uint8Array(total - sep.length);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    buf.set(p, off);
    off += p.length;
    if (i < parts.length - 1) {
      buf.set(sep, off);
      off += sep.length;
    }
  }
  const digest = sha256(buf);
  return base58.encode(digest);
}

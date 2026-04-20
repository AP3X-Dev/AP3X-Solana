import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@ap3x/solana-core';

export interface IntentIdInput {
  signalId: string;
  strategyName: string;
  instanceId: string;
  /** Defaults to 'v1'. Bump to re-issue a decision for the same (signal, strategy, instance) quad. */
  decisionVersion?: string;
}

/**
 * Derives a deterministic, idempotent intent ID from the four-field quad
 * (signalId, strategyName, instanceId, decisionVersion).
 *
 * Result: base58(sha256(signalId NUL strategyName NUL instanceId NUL decisionVersion))
 *
 * The NUL-byte separator ensures field boundaries are preserved, preventing
 * collisions such as ("ab","c") vs ("a","bc").
 */
export function intentId(input: IntentIdInput): string {
  const enc = new TextEncoder();
  const sep = enc.encode('\x00');
  const parts = [
    enc.encode(input.signalId),
    enc.encode(input.strategyName),
    enc.encode(input.instanceId),
    enc.encode(input.decisionVersion ?? 'v1'),
  ];
  let total = parts.reduce((s, p) => s + p.length, 0) + sep.length * (parts.length - 1);
  const buf = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    buf.set(parts[i]!, off);
    off += parts[i]!.length;
    if (i < parts.length - 1) {
      buf.set(sep, off);
      off += sep.length;
    }
  }
  return base58.encode(sha256(buf));
}

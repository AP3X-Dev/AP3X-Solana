import type { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';

export interface SignalFilter {
  programId?: PublicKey | PublicKey[];
  venue?: string;
  kind?: string | RegExp;
}

export function matches(filter: SignalFilter, signal: Signal): boolean {
  if (filter.programId) {
    const arr = Array.isArray(filter.programId) ? filter.programId : [filter.programId];
    if (!arr.some((p) => p.equals(signal.programId))) return false;
  }
  if (filter.venue && filter.venue !== signal.venue) return false;
  if (filter.kind) {
    if (filter.kind instanceof RegExp) { if (!filter.kind.test(signal.kind)) return false; }
    else if (filter.kind !== signal.kind) return false;
  }
  return true;
}

export function matchesAny(filters: SignalFilter[], signal: Signal): boolean {
  return filters.some((f) => matches(f, signal));
}

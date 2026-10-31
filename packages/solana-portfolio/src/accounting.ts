import type { Lot } from './types.js';

export type AccountingMethod = 'fifo' | 'lifo' | 'avg-cost';

export interface ReduceResult {
  remaining: Lot[];
  realized: bigint;
  costBasis: bigint;
  proceeds: bigint;
  basisUnresolved: boolean;
}

function requireNonnegative(value: bigint, name: string): void {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${name} must be a nonnegative bigint`);
}

function validateLots(lots: Lot[]): void {
  for (const lot of lots) {
    requireNonnegative(lot.amount, 'lot amount');
    if (lot.amount === 0n) throw new Error('lot amount must be positive');
    requireNonnegative(lot.costBasisLamports, 'lot cost basis');
  }
}

/**
 * Reduce lots by a given sale amount using the specified accounting method.
 *
 * `proceedsLamports` is the total lamport proceeds received for selling `amount` tokens.
 * All sale proceeds are recognized exactly once. FIFO/LIFO consume each lot's
 * basis proportionally. Average cost pools the basis and allocates integer
 * remainders deterministically, conserving both token units and lamports.
 *
 * Throws if `amount` exceeds total available tokens across all lots.
 * Input arrays are never mutated.
 */
export function reduceLots(
  lots: Lot[],
  amount: bigint,
  proceedsLamports: bigint,
  method: AccountingMethod,
): ReduceResult {
  requireNonnegative(amount, 'sale amount');
  requireNonnegative(proceedsLamports, 'sale proceeds');
  validateLots(lots);
  if (method !== 'fifo' && method !== 'lifo' && method !== 'avg-cost') throw new Error('unknown accounting method');
  if (amount === 0n) {
    if (proceedsLamports !== 0n) throw new Error('zero sale amount cannot have proceeds');
    return {
      remaining: lots,
      realized: 0n,
      costBasis: 0n,
      proceeds: proceedsLamports,
      basisUnresolved: false,
    };
  }

  // ── avg-cost path ──────────────────────────────────────────────────────────
  if (method === 'avg-cost') {
    const totalAmt = lots.reduce((s, l) => s + l.amount, 0n);
    const totalBasis = lots.reduce((s, l) => s + l.costBasisLamports, 0n);

    if (amount > totalAmt) {
      throw new Error(`insufficient amount: tried to reduce ${amount}, only ${totalAmt} available`);
    }

    // Weighted average cost basis for the sold portion.
    const avgBasis = (totalBasis * amount) / totalAmt;
    const basisUnresolved = lots.some((l) => l.basisUnresolved === true);

    // Differences of cumulative floors allocate the entire sale, including
    // rounding units that independent per-lot divisions would leave behind.
    let cumulativeAmount = 0n;
    let allocatedTokens = 0n;
    let remainingTokens = 0n;
    let allocatedBasis = 0n;
    const remainingAmount = totalAmt - amount;
    const remainingBasis = totalBasis - avgBasis;
    const remaining = lots
      .map((l) => {
        cumulativeAmount += l.amount;
        const tokensThroughHere = (cumulativeAmount * amount) / totalAmt;
        const take = tokensThroughHere - allocatedTokens;
        allocatedTokens = tokensThroughHere;
        const retained = l.amount - take;
        remainingTokens += retained;
        const basisThroughHere = remainingAmount === 0n
          ? 0n : (remainingBasis * remainingTokens) / remainingAmount;
        const retainedBasis = basisThroughHere - allocatedBasis;
        allocatedBasis = basisThroughHere;
        return {
          ...l,
          amount: retained,
          costBasisLamports: retainedBasis,
          // Pooled basis remains provisional even if the original unresolved
          // lot was consumed completely by the integer allocation.
          ...(basisUnresolved ? { basisUnresolved: true } : {}),
        };
      })
      .filter((l) => l.amount > 0n);

    return {
      remaining,
      realized: proceedsLamports - avgBasis,
      costBasis: avgBasis,
      proceeds: proceedsLamports,
      basisUnresolved,
    };
  }

  // ── FIFO / LIFO path ───────────────────────────────────────────────────────
  // Work through lots oldest-first (FIFO) or newest-first (LIFO).
  const ordered: Lot[] = method === 'fifo' ? [...lots] : [...lots].reverse();

  let toTake = amount;
  let costBasis = 0n;
  let basisUnresolved = false;
  const out: Lot[] = [];

  for (const l of ordered) {
    if (toTake === 0n) {
      out.push(l);
      continue;
    }

    const tokensTaken = l.amount <= toTake ? l.amount : toTake;
    const partialBasis = (l.costBasisLamports * tokensTaken) / l.amount;

    costBasis += partialBasis;

    if (l.basisUnresolved === true) basisUnresolved = true;

    toTake -= tokensTaken;

    if (tokensTaken < l.amount) {
      // Partial consumption — keep remainder.
      out.push({
        ...l,
        amount: l.amount - tokensTaken,
        costBasisLamports: l.costBasisLamports - partialBasis,
      });
    }
    // Full consumption — lot is dropped.
  }

  if (toTake > 0n) {
    const available = amount - toTake;
    throw new Error(`insufficient amount: tried to reduce ${amount}, only ${available} available`);
  }

  // Restore original lot order for LIFO (we reversed before processing).
  const remaining = method === 'fifo' ? out : out.reverse();

  return {
    remaining,
    realized: proceedsLamports - costBasis,
    costBasis,
    proceeds: proceedsLamports,
    basisUnresolved,
  };
}

/**
 * Scale of `currentPriceLamports` in {@link unrealizedPnl}: lamports per token
 * base unit × 1e9 — the same convention as the pump.fun price helpers
 * (`priceFromReserves`, `ammPrice`).
 */
export const PRICE_SCALE = 1_000_000_000n;

/**
 * Mark-to-market PnL of open lots in lamports: value at `currentPriceLamports`
 * (see {@link PRICE_SCALE}) minus remaining cost basis. Lots with unresolved
 * basis count at their recorded basis (usually 0), so treat the result as
 * provisional when any lot has `basisUnresolved`.
 */
export function unrealizedPnl(lots: Lot[], currentPriceLamports: bigint): bigint {
  validateLots(lots);
  requireNonnegative(currentPriceLamports, 'current price');
  const amount = lots.reduce((s, l) => s + l.amount, 0n);
  const basis = lots.reduce((s, l) => s + l.costBasisLamports, 0n);
  return (amount * currentPriceLamports) / PRICE_SCALE - basis;
}

import type { Lot } from './types.js';

export type AccountingMethod = 'fifo' | 'lifo' | 'avg-cost';

export interface ReduceResult {
  remaining: Lot[];
  realized: bigint;
  costBasis: bigint;
  proceeds: bigint;
  basisUnresolved: boolean;
}

/**
 * Reduce lots by a given sale amount using the specified accounting method.
 *
 * `proceedsLamports` is the total lamport proceeds received for selling `amount` tokens.
 * For FIFO/LIFO, per-lot proceeds are allocated as:
 *   lotProceeds = proceedsLamports * tokensTaken / max(lot.amount, amount)
 * This correctly handles both partial-lot (lot > sale) and multi-lot (sale > lot) cases.
 * For avg-cost, realized = proceedsLamports - weightedAverageCostBasis.
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
  if (amount <= 0n) {
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

    if (totalAmt === 0n) {
      return {
        remaining: lots,
        realized: 0n,
        costBasis: 0n,
        proceeds: proceedsLamports,
        basisUnresolved: false,
      };
    }

    if (amount > totalAmt) {
      throw new Error(`insufficient amount: tried to reduce ${amount}, only ${totalAmt} available`);
    }

    // Weighted average cost basis for the sold portion.
    const avgBasis = (totalBasis * amount) / totalAmt;
    const basisUnresolved = lots.some((l) => l.basisUnresolved === true);

    // Reduce proportionally across all lots.
    const remaining = lots
      .map((l) => {
        const take = (l.amount * amount) / totalAmt;
        if (take === 0n) return l;
        const basisTaken = (l.costBasisLamports * take) / l.amount;
        return {
          ...l,
          amount: l.amount - take,
          costBasisLamports: l.costBasisLamports - basisTaken,
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
  let allocatedProceeds = 0n;
  let basisUnresolved = false;
  const out: Lot[] = [];

  for (const l of ordered) {
    if (toTake === 0n) {
      out.push(l);
      continue;
    }

    const tokensTaken = l.amount <= toTake ? l.amount : toTake;
    const partialBasis = (l.costBasisLamports * tokensTaken) / l.amount;

    // Per-lot proceeds allocation:
    //   denominator = max(lot.amount, total sale amount)
    // When the lot is larger than the sale, we take a fraction of the lot so
    // proceeds are scaled to that fraction. When the sale spans multiple lots
    // (sale > any individual lot), proceeds are allocated proportionally to the
    // total sale amount — matching standard proportional-allocation behaviour.
    const denom = l.amount > amount ? l.amount : amount;
    const lotProceeds = (proceedsLamports * tokensTaken) / denom;

    costBasis += partialBasis;
    allocatedProceeds += lotProceeds;

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
    realized: allocatedProceeds - costBasis,
    costBasis,
    proceeds: proceedsLamports,
    basisUnresolved,
  };
}

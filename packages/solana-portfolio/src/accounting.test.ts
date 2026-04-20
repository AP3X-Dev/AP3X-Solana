import { describe, it, expect } from 'vitest';
import { reduceLots } from './accounting.js';
import type { Lot } from './types.js';

const lot = (amount: bigint, basis: bigint): Lot => ({
  amount, costBasisLamports: basis, acquiredSlot: 1, acquiredSig: 's', source: 'trade',
});

describe('reduceLots', () => {
  it('FIFO: reduces oldest lot first', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    const { remaining, realized } = reduceLots(lots, 50n, 1500n, 'fifo');
    // Take 50 from first lot (basis 500). Proceeds 50/100 of 1500 = 750. Realized = 750-500 = 250.
    expect(realized).toBe(250n);
    expect(remaining[0]!.amount).toBe(50n);
    expect(remaining[1]!.amount).toBe(100n);
  });

  it('LIFO: reduces newest lot first', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    const { remaining, realized } = reduceLots(lots, 50n, 1500n, 'lifo');
    // Take 50 from second lot (basis 1000). Proceeds 750. Realized = 750-1000 = -250.
    expect(realized).toBe(-250n);
    expect(remaining[0]!.amount).toBe(100n);
    expect(remaining[1]!.amount).toBe(50n);
  });

  it('avg-cost: uses weighted average basis across lots', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    // Avg basis per token = (1000+2000)/(100+100) = 15.
    // Sell 50 → basis = 50*15 = 750. Proceeds 1500. Realized = 750.
    const { realized } = reduceLots(lots, 50n, 1500n, 'avg-cost');
    expect(realized).toBe(750n);
  });

  it('FIFO: reduces across multiple lots when first is depleted', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    const { realized, remaining } = reduceLots(lots, 150n, 4500n, 'fifo');
    // First lot: take 100 (basis 1000). Proceeds 100/150 of 4500 = 3000. realized += 2000.
    // Second lot: take 50 (basis 1000). Proceeds 50/150 of 4500 = 1500. realized += 500.
    expect(realized).toBe(2500n);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.amount).toBe(50n);
  });

  it('flags unresolved-basis reductions', () => {
    const lots = [{ ...lot(100n, 0n), source: 'cold-start-unresolved' as const, basisUnresolved: true }];
    const { basisUnresolved } = reduceLots(lots, 50n, 1000n, 'fifo');
    expect(basisUnresolved).toBe(true);
  });
});

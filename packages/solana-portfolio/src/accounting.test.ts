import { describe, it, expect } from 'vitest';
import { reduceLots, unrealizedPnl } from './accounting.js';
import type { Lot } from './types.js';

const lot = (amount: bigint, basis: bigint): Lot => ({
  amount, costBasisLamports: basis, acquiredSlot: 1, acquiredSig: 's', source: 'trade',
});

describe('reduceLots', () => {
  it('rejects invalid accounting inputs before returning a result', () => {
    const lots = [lot(2n, 10n)];
    expect(() => reduceLots(lots, -1n, 0n, 'fifo')).toThrow();
    expect(() => reduceLots(lots, 1n, -1n, 'lifo')).toThrow();
    expect(() => reduceLots(lots, 0n, 10n, 'avg-cost')).toThrow();
    expect(() => reduceLots(lots, 1n, 10n, 'unknown' as never)).toThrow();
    expect(() => reduceLots([lot(0n, 10n)], 1n, 10n, 'fifo')).toThrow();
    expect(() => reduceLots([lot(-2n, 10n)], 1n, 10n, 'fifo')).toThrow();
    expect(() => reduceLots([lot(2n, -10n)], 1n, 10n, 'avg-cost')).toThrow();
    expect(() => reduceLots(lots, 1 as never, 10n, 'fifo')).toThrow();
    expect(() => unrealizedPnl(lots, -1n)).toThrow();
    expect(() => unrealizedPnl([lot(-2n, 1n)], 1n)).toThrow();
  });

  it('treats zero quantity and proceeds as a no-op, including empty inventory', () => {
    const lots = [lot(2n, 10n)];
    expect(reduceLots(lots, 0n, 0n, 'fifo')).toEqual({ remaining: lots, realized: 0n,
      costBasis: 0n, proceeds: 0n, basisUnresolved: false });
    expect(reduceLots([], 0n, 0n, 'avg-cost').remaining).toEqual([]);
    expect(unrealizedPnl([], 0n)).toBe(0n);
  });

  it.each(['fifo', 'lifo', 'avg-cost'] as const)('%s conserves token units, basis and sale proceeds at integer boundaries', (method) => {
    for (let a = 1n; a <= 5n; a++) {
      for (let b = 1n; b <= 5n; b++) {
        for (let sold = 1n; sold <= a + b; sold++) {
          const lots = [lot(a, 17n), lot(b, 31n)];
          const before = structuredClone(lots);
          const result = reduceLots(lots, sold, 101n, method);
          expect(result.remaining.reduce((sum, l) => sum + l.amount, 0n)).toBe(a + b - sold);
          expect(result.remaining.reduce((sum, l) => sum + l.costBasisLamports, 0n) + result.costBasis).toBe(48n);
          expect(result.realized + result.costBasis).toBe(101n);
          expect(result.proceeds).toBe(101n);
          expect(result.remaining.every((l) => l.amount > 0n && l.costBasisLamports >= 0n)).toBe(true);
          expect(lots).toEqual(before);
        }
      }
    }
  });

  it.each(['fifo', 'lifo', 'avg-cost'] as const)('%s rejects a sale from empty or insufficient inventory', (method) => {
    expect(() => reduceLots([], 1n, 10n, method)).toThrow('insufficient amount');
    expect(() => reduceLots([lot(1n, 2n)], 2n, 10n, method)).toThrow('insufficient amount');
  });

  it('retains unresolved basis across average-cost remainder allocations', () => {
    const result = reduceLots([{ ...lot(1n, 0n), basisUnresolved: true }, lot(2n, 30n)], 2n, 40n, 'avg-cost');
    expect(result.basisUnresolved).toBe(true);
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0]).toMatchObject({ amount: 1n, costBasisLamports: 10n, basisUnresolved: true });
  });

  it('FIFO: reduces oldest lot first', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    const { remaining, realized } = reduceLots(lots, 50n, 1500n, 'fifo');
    // Proceeds are for the sale, not for the whole original lot.
    expect(realized).toBe(1000n);
    expect(remaining[0]!.amount).toBe(50n);
    expect(remaining[1]!.amount).toBe(100n);
  });

  it('LIFO: reduces newest lot first', () => {
    const lots = [lot(100n, 1000n), lot(100n, 2000n)];
    const { remaining, realized } = reduceLots(lots, 50n, 1500n, 'lifo');
    expect(realized).toBe(500n);
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

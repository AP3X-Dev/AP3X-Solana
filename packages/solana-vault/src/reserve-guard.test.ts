import { describe, expect, it } from 'vitest';

import { checkSpend } from './reserve-guard';

describe('reserve-guard — checkSpend', () => {
  it('allows a spend that leaves the balance above the reserve', () => {
    const result = checkSpend({
      reserveLamports: 1_000_000n,
      currentBalance: 10_000_000n,
      txEstimatedDelta: -5_000_000n,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a spend that drops the projected balance below the reserve', () => {
    const result = checkSpend({
      reserveLamports: 1_000_000n,
      currentBalance: 2_000_000n,
      txEstimatedDelta: -1_500_000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Reason carries both amounts so higher layers can log actionable output
      // without re-deriving the numbers.
      expect(result.reason).toMatch(/reserve breach/i);
      expect(result.reason).toContain('500000');
      expect(result.reason).toContain('1000000');
      expect(result.projectedBalance).toBe(500_000n);
      expect(result.reserveLamports).toBe(1_000_000n);
    }
  });

  it('allows a zero-delta transaction (read-only / no-op)', () => {
    // A tx with no net lamport movement (e.g. pure compute-budget ping) must
    // never trip the guard even if balance is exactly at the reserve.
    const result = checkSpend({
      reserveLamports: 1_000_000n,
      currentBalance: 1_000_000n,
      txEstimatedDelta: 0n,
    });
    expect(result.ok).toBe(true);
  });

  it('treats positive deltas (incoming transfers) as always safe vs reserve', () => {
    const result = checkSpend({
      reserveLamports: 5_000_000n,
      currentBalance: 3_000_000n, // below reserve already (informational)
      txEstimatedDelta: 4_000_000n, // net +4M
    });
    // Projected 7M > reserve 5M → ok. The guard only cares about the
    // post-transaction balance, not whether we're currently above/below.
    expect(result.ok).toBe(true);
  });

  it('treats projected balance exactly equal to the reserve as ok (reserve is the floor, not strict)', () => {
    // Per spec: reserve is the minimum-allowed post-transaction balance, so
    // landing exactly on it must be accepted. Using strict `<` below means
    // equality is ok.
    const result = checkSpend({
      reserveLamports: 1_000_000n,
      currentBalance: 2_000_000n,
      txEstimatedDelta: -1_000_000n,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a spend that lands just one lamport below the reserve', () => {
    const result = checkSpend({
      reserveLamports: 1_000_000n,
      currentBalance: 2_000_000n,
      txEstimatedDelta: -1_000_001n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.projectedBalance).toBe(999_999n);
    }
  });

  it('handles large bigints (>2^53) without precision loss', () => {
    // 10^18 range is larger than Number.MAX_SAFE_INTEGER, so any Number
    // coercion inside checkSpend would corrupt the arithmetic. Keep it bigint.
    const huge = 1_000_000_000_000_000_000n;
    const result = checkSpend({
      reserveLamports: huge,
      currentBalance: huge + 500n,
      txEstimatedDelta: -1000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.projectedBalance).toBe(huge - 500n);
    }
  });

  it('accepts zero reserve (no floor) for any non-bankrupting spend', () => {
    const result = checkSpend({
      reserveLamports: 0n,
      currentBalance: 1_000_000n,
      txEstimatedDelta: -1_000_000n,
    });
    expect(result.ok).toBe(true); // projected 0 >= reserve 0
  });

  it('rejects a spend that would overdraw to a negative balance even with zero reserve', () => {
    // Reserve 0 doesn't license negative balances — projected must still be
    // >= 0 (the implicit floor of reserve=0).
    const result = checkSpend({
      reserveLamports: 0n,
      currentBalance: 500n,
      txEstimatedDelta: -1000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.projectedBalance).toBe(-500n);
    }
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { SqlitePumpfunSignals, SIGNAL_VERSIONS } from './sqlite.js';

let hasBetterSqlite3 = false;
try {
  const Database = (await import('better-sqlite3' as any)).default;
  const probe = new Database(':memory:');
  probe.close();
  hasBetterSqlite3 = true;
} catch {
  hasBetterSqlite3 = false;
}

describe.skipIf(!hasBetterSqlite3)('SqlitePumpfunSignals', () => {
  let signals: SqlitePumpfunSignals;

  beforeEach(async () => {
    signals = new SqlitePumpfunSignals({ path: ':memory:' });
    await signals.init();
  });

  it('exposes per-method signal versions', () => {
    expect(signals.versions).toEqual(SIGNAL_VERSIONS);
    expect(signals.versions.walletTier).toBeTruthy();
    expect(signals.versions.convergenceState).toBeTruthy();
    expect(signals.versions.milestoneEvents).toBeTruthy();
    expect(signals.versions.safetyVerdict).toBeTruthy();
  });

  // ── walletTier ────────────────────────────────────────────────────

  describe('walletTier', () => {
    it('returns null for an unknown wallet', async () => {
      const t = await signals.walletTier({ wallet: 'unknown', asOf: new Date() });
      expect(t).toBeNull();
    });

    it('returns the most recent tier observed at-or-before asOf', async () => {
      const now = Date.now();
      await signals.ingestWalletTier({ wallet: 'w1', tier: 'B', observedAt: new Date(now - 2000) });
      await signals.ingestWalletTier({ wallet: 'w1', tier: 'A', observedAt: new Date(now - 1000) });
      await signals.ingestWalletTier({ wallet: 'w1', tier: 'S', observedAt: new Date(now)        });

      const t = await signals.walletTier({ wallet: 'w1', asOf: new Date(now) });
      expect(t).toBe('S');
    });

    it('does not return tiers observed after asOf (asOf enforcement)', async () => {
      const now = Date.now();
      await signals.ingestWalletTier({ wallet: 'w1', tier: 'B', observedAt: new Date(now - 2000) });
      await signals.ingestWalletTier({ wallet: 'w1', tier: 'A', observedAt: new Date(now + 5000) }); // after

      const t = await signals.walletTier({ wallet: 'w1', asOf: new Date(now) });
      expect(t).toBe('B');
    });
  });

  // ── convergenceState ──────────────────────────────────────────────

  describe('convergenceState', () => {
    it('returns zeroed state when nobody has bought', async () => {
      const c = await signals.convergenceState({
        mint: 'mint-x',
        asOf: new Date(),
        windowMs: 60_000,
      });
      expect(c.totalBuyers).toBe(0);
      expect(c.firstBuyAt).toBeNull();
      expect(c.latestBuyAt).toBeNull();
      expect(c.buyersByTier).toEqual({ S: 0, A: 0, B: 0, C: 0, D: 0 });
    });

    it('counts distinct buyers in the window, grouped by tier', async () => {
      const now = Date.now();
      await signals.ingestBuy({ signature: 's1', slot: 1, observedAt: new Date(now - 30_000), mint: 'm', wallet: 'w-S1', buyerTier: 'S' });
      await signals.ingestBuy({ signature: 's2', slot: 2, observedAt: new Date(now - 20_000), mint: 'm', wallet: 'w-S2', buyerTier: 'S' });
      await signals.ingestBuy({ signature: 's3', slot: 3, observedAt: new Date(now - 10_000), mint: 'm', wallet: 'w-A1', buyerTier: 'A' });
      // Same wallet buys again — should not double-count.
      await signals.ingestBuy({ signature: 's4', slot: 4, observedAt: new Date(now - 5_000),  mint: 'm', wallet: 'w-S1', buyerTier: 'S' });

      const c = await signals.convergenceState({ mint: 'm', asOf: new Date(now), windowMs: 60_000 });
      expect(c.buyersByTier.S).toBe(2);
      expect(c.buyersByTier.A).toBe(1);
      expect(c.totalBuyers).toBe(3);
    });

    it('excludes buys outside the window', async () => {
      const now = Date.now();
      await signals.ingestBuy({ signature: 'old', slot: 1, observedAt: new Date(now - 120_000), mint: 'm', wallet: 'w1', buyerTier: 'S' });
      await signals.ingestBuy({ signature: 'in',  slot: 2, observedAt: new Date(now - 30_000),  mint: 'm', wallet: 'w2', buyerTier: 'A' });

      const c = await signals.convergenceState({ mint: 'm', asOf: new Date(now), windowMs: 60_000 });
      expect(c.totalBuyers).toBe(1);
      expect(c.buyersByTier.A).toBe(1);
      expect(c.buyersByTier.S).toBe(0);
    });

    it('does not include buys observed after asOf', async () => {
      const now = Date.now();
      await signals.ingestBuy({ signature: 'in',     slot: 1, observedAt: new Date(now - 5_000),  mint: 'm', wallet: 'w1', buyerTier: 'S' });
      await signals.ingestBuy({ signature: 'future', slot: 2, observedAt: new Date(now + 10_000), mint: 'm', wallet: 'w2', buyerTier: 'A' });

      const c = await signals.convergenceState({ mint: 'm', asOf: new Date(now), windowMs: 60_000 });
      expect(c.totalBuyers).toBe(1);
    });

    it('reports firstBuyAt and latestBuyAt when buys exist', async () => {
      const t1 = Date.now() - 30_000;
      const t2 = Date.now() - 5_000;
      await signals.ingestBuy({ signature: 's1', slot: 1, observedAt: new Date(t1), mint: 'm', wallet: 'w1', buyerTier: 'S' });
      await signals.ingestBuy({ signature: 's2', slot: 2, observedAt: new Date(t2), mint: 'm', wallet: 'w2', buyerTier: 'S' });

      const c = await signals.convergenceState({ mint: 'm', asOf: new Date(), windowMs: 60_000 });
      expect(c.firstBuyAt?.getTime()).toBe(t1);
      expect(c.latestBuyAt?.getTime()).toBe(t2);
    });
  });

  // ── milestoneEvents ───────────────────────────────────────────────

  describe('milestoneEvents', () => {
    it('returns empty for a mint with no milestones', async () => {
      const m = await signals.milestoneEvents({
        mint: 'no-mint',
        since: new Date(0),
        asOf:  new Date(),
      });
      expect(m).toEqual([]);
    });

    it('returns milestones in observedAt-ascending order', async () => {
      const t1 = Date.now() - 30_000;
      const t2 = Date.now() - 20_000;
      const t3 = Date.now() - 10_000;
      await signals.ingestMilestone({ mint: 'm', kind: 'graduated', observedAt: new Date(t3) });
      await signals.ingestMilestone({ mint: 'm', kind: 'created',   observedAt: new Date(t1) });
      await signals.ingestMilestone({ mint: 'm', kind: 'first-buy', observedAt: new Date(t2) });

      const m = await signals.milestoneEvents({ mint: 'm', since: new Date(0), asOf: new Date() });
      expect(m.map((e) => e.kind)).toEqual(['created', 'first-buy', 'graduated']);
    });

    it('respects since and asOf bounds (inclusive)', async () => {
      const t1 = 1000;
      const t2 = 2000;
      const t3 = 3000;
      await signals.ingestMilestone({ mint: 'm', kind: 'created',  observedAt: new Date(t1) });
      await signals.ingestMilestone({ mint: 'm', kind: 'fdv-50k',  observedAt: new Date(t2) });
      await signals.ingestMilestone({ mint: 'm', kind: 'fdv-100k', observedAt: new Date(t3) });

      const m = await signals.milestoneEvents({
        mint:  'm',
        since: new Date(t2),
        asOf:  new Date(t2),
      });
      expect(m.map((e) => e.kind)).toEqual(['fdv-50k']);
    });

    it('preserves milestone data payload when present', async () => {
      await signals.ingestMilestone({
        mint: 'm', kind: 'fdv-50k', observedAt: new Date(),
        data: { fdvUsd: 51_234 },
      });
      const m = await signals.milestoneEvents({ mint: 'm', since: new Date(0), asOf: new Date() });
      expect(m[0]?.data).toEqual({ fdvUsd: 51_234 });
    });
  });

  // ── safetyVerdict ─────────────────────────────────────────────────

  describe('safetyVerdict', () => {
    it("returns 'unknown' for an unclassified mint", async () => {
      const v = await signals.safetyVerdict({ mint: 'fresh', asOf: new Date() });
      expect(v.verdict).toBe('unknown');
      expect(v.reasons).toEqual([]);
      expect(v.signals).toEqual({});
    });

    it('returns the most recent verdict observed at-or-before asOf', async () => {
      const now = Date.now();
      await signals.ingestSafetyVerdict({ mint: 'm', observedAt: new Date(now - 2000), verdict: 'safe',    reasons: ['initial'], signals: { topHolderPct: 8 } });
      await signals.ingestSafetyVerdict({ mint: 'm', observedAt: new Date(now - 1000), verdict: 'warning', reasons: ['mint-authority-still-set'], signals: { mintAuthority: true } });

      const v = await signals.safetyVerdict({ mint: 'm', asOf: new Date(now) });
      expect(v.verdict).toBe('warning');
      expect(v.reasons).toEqual(['mint-authority-still-set']);
    });

    it('does not return verdicts observed after asOf', async () => {
      const now = Date.now();
      await signals.ingestSafetyVerdict({ mint: 'm', observedAt: new Date(now - 5000), verdict: 'safe',   reasons: [], signals: {} });
      await signals.ingestSafetyVerdict({ mint: 'm', observedAt: new Date(now + 5000), verdict: 'danger', reasons: [], signals: {} });

      const v = await signals.safetyVerdict({ mint: 'm', asOf: new Date(now) });
      expect(v.verdict).toBe('safe');
    });
  });

  // ── close ─────────────────────────────────────────────────────────

  it('close() is idempotent', async () => {
    await signals.close();
    await signals.close();
  });
});

describe.skipIf(hasBetterSqlite3)('SqlitePumpfunSignals — skipped', () => {
  it('better-sqlite3 native binding unavailable', () => {});
});

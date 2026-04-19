/**
 * `PriorityFeeEstimator` — observe landed transactions via Geyser and
 * surface a rolling percentile-based priority fee estimate.
 *
 * Per spec Section 3.3 + plan decision: the substrate never lets a strategy
 * pick lamports directly. Instead it picks a tier (`low`/`med`/`high`/`turbo`)
 * and the estimator resolves that tier to a microLamports-per-CU value
 * computed from the most recent ~150 slots of on-chain activity.
 *
 * Signal source: Yellowstone Geyser `subscribeTransactions` with
 * `vote=false, failed=false`. Each landed transaction carries `meta.fee`
 * (lamports) and `meta.computeUnitsConsumed`. The effective priority fee
 * rate is:
 *
 *     microLamportsPerCu = (fee_lamports - signerCount * 5000) * 1_000_000 / unitsConsumed
 *
 * Signer base cost: Solana charges a flat 5000 lamports per signer as the
 * "signature fee"; anything on top is the priority fee (optionally set by
 * the tx via `ComputeBudgetInstruction::SetComputeUnitPrice`). Subtracting
 * the base from `meta.fee` and dividing by consumed CUs gives the effective
 * rate that the leader saw when ordering the tx.
 *
 * We convert to microLamports (Solana's canonical fee-unit for priority
 * pricing — 1 microLamport = 1e-6 lamport) and express it as a floating-
 * point number per CU. The internal ring stores these sample points tagged
 * with the slot they were observed in so old samples age out cleanly.
 *
 * Tier mapping:
 *   - low    = p50 of windowed samples
 *   - med    = p75
 *   - high   = p90
 *   - turbo  = p99 * 1.10  (+10% topup for blockspace contention edge)
 *
 * Warmup: until we've observed `warmupSlots` distinct slots (default 30),
 * the estimator returns a conservative default set chosen to roughly
 * match typical idle-network rates — the goal is a cheap tx that still
 * stands a chance of landing when the blockspace market is quiet:
 *
 *   { low: 1, med: 10, high: 100, turbo: 1000 }
 *
 * Shutdown: `close()` unsubscribes from the underlying `Subscription`.
 * Multiple `close()` calls are safe — subsequent calls are no-ops.
 *
 * Zero ecosystem deps: only `@ap3x/solana-connectivity` for the injected
 * `GeyserClient` type.
 */

import type { GeyserClient, GeyserUpdate, Subscription } from '@ap3x/solana-connectivity';

/** Fee tier label passed to {@link PriorityFeeEstimator.tier}. */
export type FeeTier = 'low' | 'med' | 'high' | 'turbo';

/** Flat per-signer signature fee charged by the Solana runtime, in lamports. */
export const SIGNATURE_FEE_LAMPORTS = 5000;

/** Micro-units per lamport. Priority-fee rates are expressed per CU at this scale. */
const MICROLAMPORTS_PER_LAMPORT = 1_000_000;

/** Conservative pre-warmup defaults in microLamports per CU. */
export const WARMUP_DEFAULTS: Record<FeeTier, number> = {
  low: 1,
  med: 10,
  high: 100,
  turbo: 1000,
};

/** Default window of rolling slots retained for percentile computation. */
const DEFAULT_WINDOW_SLOTS = 150;

/** Default number of distinct slots observed before percentile takes over. */
const DEFAULT_WARMUP_SLOTS = 30;

/**
 * Options for {@link PriorityFeeEstimator}.
 */
export interface PriorityFeeEstimatorOptions {
  /**
   * Injected Geyser client. The estimator calls `subscribe` with a
   * transactions filter on `vote=false, failed=false` and processes each
   * landed tx update.
   */
  geyser: GeyserClient;

  /** How many slots of samples to retain. Defaults to {@link DEFAULT_WINDOW_SLOTS}. */
  windowSlots?: number;

  /**
   * How many distinct slots must be observed before the percentile estimator
   * takes over from {@link WARMUP_DEFAULTS}. Defaults to {@link DEFAULT_WARMUP_SLOTS}.
   */
  warmupSlots?: number;

  /** Optional hook called each time a new slot is seen (for tests / metrics). */
  onSlot?: (slot: number) => void;
}

/**
 * A single observation: the effective priority-fee rate a single landed
 * transaction paid, tagged with the slot it landed in.
 */
interface FeeSample {
  slot: number;
  microLamportsPerCu: number;
}

/**
 * Shape of the raw transaction Geyser update payload we care about. We type
 * only the fields we read — the rest of the proto lives in
 * `solana-connectivity` as a loose bag.
 *
 * Yellowstone lays the envelope out as either:
 *
 *   { transaction: { slot, signatures, meta, transaction: { message, ... } } }
 *
 * or `{ slot: { slot, ... } }` for standalone slot updates. We handle both.
 */
interface TransactionUpdateLoose {
  transaction?: {
    slot?: string | number;
    signatures?: unknown[];
    meta?: {
      fee?: string | number;
      err?: unknown;
      computeUnitsConsumed?: string | number;
    };
    transaction?: {
      signatures?: unknown[];
      message?: {
        header?: {
          numRequiredSignatures?: number;
        };
      };
    };
  };
}

export class PriorityFeeEstimator {
  readonly #geyser: GeyserClient;
  readonly #windowSlots: number;
  readonly #warmupSlots: number;
  readonly #onSlot: ((slot: number) => void) | undefined;

  /** Ring of samples, appended in observation order. Pruned by slot on every insert. */
  readonly #samples: FeeSample[] = [];

  /** Distinct slots observed — used to gate the warmup → live transition. */
  readonly #slotsSeen = new Set<number>();

  /** Highest slot observed so far. */
  #lastSlot = -1;

  #subscription: Subscription | undefined;
  #started = false;
  #closed = false;

  constructor(opts: PriorityFeeEstimatorOptions) {
    if (!opts.geyser) {
      throw new TypeError('PriorityFeeEstimator: geyser is required');
    }
    const windowSlots = opts.windowSlots ?? DEFAULT_WINDOW_SLOTS;
    const warmupSlots = opts.warmupSlots ?? DEFAULT_WARMUP_SLOTS;
    if (windowSlots < 1) {
      throw new RangeError('PriorityFeeEstimator: windowSlots must be >= 1');
    }
    if (warmupSlots < 0) {
      throw new RangeError('PriorityFeeEstimator: warmupSlots must be >= 0');
    }
    this.#geyser = opts.geyser;
    this.#windowSlots = windowSlots;
    this.#warmupSlots = warmupSlots;
    this.#onSlot = opts.onSlot;
  }

  /**
   * Subscribe to Geyser for landed-transaction updates. Idempotent: a
   * second call is a no-op so callers can treat startup as "ensure".
   */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#subscription = this.#geyser.subscribe(
      {
        transactions: {
          'priority-fee': {
            vote: false,
            failed: false,
          },
        },
        commitment: 'confirmed',
      },
      (update: GeyserUpdate) => {
        this.#onUpdate(update);
      },
    );
  }

  /**
   * Terminate the subscription. Safe to call multiple times and from
   * inside event handlers.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#subscription?.close();
    } catch {
      // close() on a dead stream can throw — we don't care.
    }
    this.#subscription = undefined;
  }

  /**
   * Resolve a tier to a microLamports-per-CU rate. During warmup returns
   * the conservative defaults; after warmup returns the percentile over
   * the windowed samples.
   */
  tier(t: FeeTier): number {
    if (this.#slotsSeen.size < this.#warmupSlots) {
      return WARMUP_DEFAULTS[t];
    }
    const percentile = this.#tierPercentile(t);
    const sorted = this.#samples
      .map((s) => s.microLamportsPerCu)
      .sort((a, b) => a - b);
    if (sorted.length === 0) {
      return WARMUP_DEFAULTS[t];
    }
    const base = quantile(sorted, percentile);
    return t === 'turbo' ? base * 1.1 : base;
  }

  /**
   * Map a tier label to its percentile on the `[0, 1]` range.
   * `turbo` gets the p99 value + 10% topup applied by the caller.
   */
  #tierPercentile(t: FeeTier): number {
    switch (t) {
      case 'low':
        return 0.5;
      case 'med':
        return 0.75;
      case 'high':
        return 0.9;
      case 'turbo':
        return 0.99;
    }
  }

  // ---- Inspection helpers (mostly for tests + diagnostics) --------------

  /** Current number of retained samples. */
  sampleCount(): number {
    return this.#samples.length;
  }

  /** Highest slot observed, or -1 before any data arrives. */
  lastSlot(): number {
    return this.#lastSlot;
  }

  /** True until `warmupSlots` distinct slots have been observed. */
  isWarmup(): boolean {
    return this.#slotsSeen.size < this.#warmupSlots;
  }

  /**
   * Feed a raw sample directly into the ring. Exposed for tests that build
   * synthetic fee distributions without going through Geyser. Production
   * callers should never need this.
   */
  _ingestSample(slot: number, microLamportsPerCu: number): void {
    this.#ingestSample(slot, microLamportsPerCu);
  }

  // ---- Internals -------------------------------------------------------

  #onUpdate(update: GeyserUpdate): void {
    // We care about two kinds of updates:
    //   - `slot` — to advance the window-pruner even when no txs land
    //   - `transaction` — the actual fee sample source
    const u = update as unknown as TransactionUpdateLoose;
    if (update.slot && update.slot.slot !== undefined) {
      const slot = Number(update.slot.slot);
      this.#observeSlot(slot);
      return;
    }
    if (!u.transaction) return;
    const txSlot =
      u.transaction.slot !== undefined ? Number(u.transaction.slot) : undefined;
    if (txSlot !== undefined) this.#observeSlot(txSlot);

    const meta = u.transaction.meta;
    if (!meta) return;
    // Landed failed txs don't produce useful priority-fee signal. The
    // Geyser filter already excludes them, but we guard defensively.
    if (meta.err != null) return;
    const feeLamports = meta.fee !== undefined ? Number(meta.fee) : NaN;
    const unitsConsumed = meta.computeUnitsConsumed !== undefined
      ? Number(meta.computeUnitsConsumed)
      : NaN;
    const sigCount = this.#extractSigCount(u);
    if (!Number.isFinite(feeLamports) || !Number.isFinite(unitsConsumed)) return;
    if (unitsConsumed <= 0) return;
    const priorityLamports = feeLamports - sigCount * SIGNATURE_FEE_LAMPORTS;
    if (priorityLamports < 0) return; // Malformed fee — skip.
    const microLamportsPerCu =
      (priorityLamports * MICROLAMPORTS_PER_LAMPORT) / unitsConsumed;

    const sampleSlot = txSlot ?? this.#lastSlot;
    if (sampleSlot < 0) return; // No slot context yet — drop the sample.
    this.#ingestSample(sampleSlot, microLamportsPerCu);
  }

  /**
   * Resolve the number of required signatures from the Geyser tx payload.
   * Yellowstone serialises it on `transaction.transaction.message.header.numRequiredSignatures`
   * when `keepCase: false` (the default in our client). We also fall back
   * to `signatures.length` when the header is missing, since outer signature
   * count matches the required-signer count on a well-formed tx.
   */
  #extractSigCount(u: TransactionUpdateLoose): number {
    const hdr =
      u.transaction?.transaction?.message?.header?.numRequiredSignatures;
    if (typeof hdr === 'number' && hdr > 0) return hdr;
    const outer = u.transaction?.signatures;
    if (Array.isArray(outer) && outer.length > 0) return outer.length;
    const inner = u.transaction?.transaction?.signatures;
    if (Array.isArray(inner) && inner.length > 0) return inner.length;
    return 1; // Assume single signer as the conservative default.
  }

  #observeSlot(slot: number): void {
    if (!Number.isFinite(slot) || slot < 0) return;
    const isNew = !this.#slotsSeen.has(slot);
    this.#slotsSeen.add(slot);
    if (slot > this.#lastSlot) this.#lastSlot = slot;
    this.#pruneWindow();
    if (isNew && this.#onSlot) {
      try {
        this.#onSlot(slot);
      } catch {
        // Observer errors must not poison the stream.
      }
    }
  }

  #ingestSample(slot: number, microLamportsPerCu: number): void {
    if (!Number.isFinite(microLamportsPerCu) || microLamportsPerCu < 0) return;
    this.#observeSlot(slot);
    this.#samples.push({ slot, microLamportsPerCu });
    this.#pruneWindow();
  }

  /**
   * Drop samples that fall outside `[lastSlot - windowSlots, lastSlot]`.
   * The window is a strict slot-bounded range — not an item count — so
   * a burst of txs in one slot doesn't evict older but still-relevant data.
   */
  #pruneWindow(): void {
    if (this.#lastSlot < 0) return;
    const minSlot = this.#lastSlot - this.#windowSlots + 1;
    if (minSlot <= 0) return;
    // Samples are appended in chronological order but slot ordering isn't
    // strictly monotonic across Geyser delivery — a late-arriving tx for
    // an earlier slot can appear after a newer slot update. Iterate and
    // filter; the window size is small (150 slots * few txs per slot),
    // so an O(n) rewrite per insert is cheap and stays memory-flat.
    let write = 0;
    for (let read = 0; read < this.#samples.length; read++) {
      const s = this.#samples[read]!;
      if (s.slot >= minSlot) {
        this.#samples[write++] = s;
      }
    }
    this.#samples.length = write;

    // Prune slotsSeen too so warmup accounting tracks the live window.
    for (const s of this.#slotsSeen) {
      if (s < minSlot) this.#slotsSeen.delete(s);
    }
  }
}

/**
 * Linear-interpolation quantile over a pre-sorted ascending array. Matches
 * NumPy's default "linear" method — the same one most dashboards use — so
 * reported p90s align with observability tooling.
 *
 * For `p = 0.5` on `[1, 2, 3]` returns `2`; for `p = 0.99` on
 * `[1, 2, ..., 100]` returns ≈ `99.01`.
 *
 * Exported for tests; callers should use {@link PriorityFeeEstimator.tier}.
 */
export function quantile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new Error('quantile: empty sample set');
  }
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 1) return sortedAsc[sortedAsc.length - 1]!;
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/**
 * CheckpointStore — interface for persisting Geyser stream progress so a
 * subscriber can resume after a process restart or reconnect without losing
 * or duplicating its view of the slot timeline.
 *
 * Deliberately narrow:
 *
 *   - `load(key)` returns the last persisted checkpoint for this endpoint key,
 *     or `null` if nothing is saved yet. A missing store is NOT an error;
 *     callers treat `null` as "start from wherever the server begins."
 *   - `save(key, ckpt)` is fire-and-forget from the client's perspective — it
 *     is awaited inside the GeyserClient worker, but the GeyserClient does
 *     not tear down on save errors. If a store is misbehaving, the client
 *     emits 'error' and keeps streaming; losing a checkpoint is better than
 *     losing a subscription.
 *   - `key` is an opaque string chosen by the caller (e.g. the endpoint URL,
 *     or `{url}#{subscriptionName}` if multiple subscriptions share one
 *     endpoint). The store does not interpret it.
 *
 * T14 defines the interface only. T15 will land `FileCheckpointStore`, which
 * writes JSON to disk with an atomic-rename swap so a crash mid-write cannot
 * corrupt the persisted state.
 */

export interface Checkpoint {
  /** Highest slot observed in the Geyser stream before this checkpoint. */
  lastSlot: number;
  /** Running count of updates applied since subscription start. */
  updateCount: number;
  /** ISO-8601 timestamp when the checkpoint was taken. */
  timestamp: string;
}

export interface CheckpointStore {
  load(key: string): Promise<Checkpoint | null>;
  save(key: string, ckpt: Checkpoint): Promise<void>;
}

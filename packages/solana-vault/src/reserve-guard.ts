/**
 * SOL reserve guard — a pure, synchronous policy primitive that decides
 * whether a transaction is allowed to leave the wallet below a configured
 * lamport floor.
 *
 * Per PRP-01 Section 3.7, every signed transaction for a role-tagged wallet
 * passes through this check before `WalletHandle.signTransaction` will emit
 * bytes. Keeping the function pure (no IO, no async) keeps the policy easy
 * to unit-test and easy to reason about in code review.
 *
 * The caller is responsible for:
 *  - resolving `reserveLamports` from the Vault's role map,
 *  - fetching `currentBalance` from a live RPC/Geyser source,
 *  - computing `txEstimatedDelta` (signed; spend = negative, receive = positive)
 *    from the transaction bytes (expected to include priority fee + SOL moves).
 */

export interface ReserveCheckInput {
  /**
   * Minimum post-transaction balance, in lamports. The wallet's balance after
   * this transaction must be >= this value. Resolved by the Vault from
   * `solReserveByRole[role]` at unlock time.
   */
  reserveLamports: bigint;
  /**
   * Signed net lamport change this transaction will cause.
   *  - Spend (outflow):  negative (e.g. `-5_000_000n`)
   *  - Receive (inflow): positive (e.g. `+5_000_000n`)
   *  - Read-only / no-op: `0n`
   *
   * Fees MUST be included in the delta — the guard only knows what it's told.
   */
  txEstimatedDelta: bigint;
  /** Current wallet balance in lamports. */
  currentBalance: bigint;
}

export type ReserveCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      projectedBalance: bigint;
      reserveLamports: bigint;
    };

/**
 * Evaluate whether a spend is allowed under the reserve policy.
 *
 * Decision rule: `projectedBalance = currentBalance + txEstimatedDelta`.
 * The check passes if `projectedBalance >= reserveLamports` — the reserve is
 * the inclusive floor, not a strict bound. This matches the spec intent ("the
 * resulting balance ... would drop below the reserve" uses strict `<` below
 * the reserve as the rejection condition).
 *
 * The function is BigInt-native. Do not coerce inputs to Number — Solana
 * balances and fee estimates can exceed `Number.MAX_SAFE_INTEGER` for large
 * treasury wallets and mis-scaled fee tables.
 */
export function checkSpend(input: ReserveCheckInput): ReserveCheckResult {
  const { reserveLamports, txEstimatedDelta, currentBalance } = input;
  const projectedBalance = currentBalance + txEstimatedDelta;
  if (projectedBalance < reserveLamports) {
    return {
      ok: false,
      reason: `reserve breach: projected balance ${projectedBalance} lamports < reserve ${reserveLamports} lamports`,
      projectedBalance,
      reserveLamports,
    };
  }
  return { ok: true };
}

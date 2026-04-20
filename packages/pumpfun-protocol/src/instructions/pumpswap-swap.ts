/**
 * `buildPumpSwapSwap` — pure instruction builder for PumpSwap's AMM Swap.
 *
 * After a pump.fun bonding curve graduates, liquidity migrates to a PumpSwap
 * AMM pool. This builder produces the single bidirectional Swap instruction
 * used for both buys and sells post-graduation — direction is expressed
 * implicitly by which of `inputMint` / `outputMint` is wSOL (buy = SOL in /
 * token out; sell = token in / SOL out).
 *
 * Pure: returns `{ programId, keys, data }`. No signing, no network. Hand
 * the result to `@ap3x/solana-tx.assemble` with a signer list covering
 * `user`.
 *
 * -----------------------------------------------------------------------
 * BEST-EFFORT ASSUMPTIONS (unverified, flagged for mainnet confirmation):
 * -----------------------------------------------------------------------
 *
 *   1. **Account layout.** PumpSwap's Swap account order is ASSUMED — the
 *      program has no published IDL and no captured Swap transaction yet
 *      (blocked on a Helius API key). The 13-account layout below follows
 *      the typical AMM Swap shape: pool, user (signer), input/output mints,
 *      user input/output ATAs, pool base/quote vaults, base/quote mints,
 *      token program, event authority, program (for the Anchor event CPI
 *      self-log). Vault derivations are deferred to the caller for now
 *      because the seed recipe is also unverified — exposing vault-derived
 *      PDAs here would lock in an unchecked shape.
 *
 *   2. **PumpSwap Swap discriminator.** `INSTRUCTION_DISCRIMINATORS.pumpSwapSwap`
 *      (`f8c69e91e17587c8`) is ASSUMED from the Anchor naming convention
 *      `sha256("global:swap")[..8]`. Verify during the live-sample capture
 *      checkpoint — if it drifts, update `borsh.ts` and the test together.
 *
 *   3. **Pool-vault accounts (positions 7–8).** These are the pool's ATAs
 *      for base/quote mints. We leave them as derived-from-pool placeholders
 *      (reusing the pool address at both positions) so the shape test
 *      exercises positional correctness without claiming vault-derivation
 *      correctness. Once the captured fixture confirms the recipe, swap
 *      the placeholders for real `findProgramAddress` calls and update
 *      `account-derivation.ts` accordingly.
 *
 * When the live-sample checkpoint lands, update this file and the roundtrip
 * fixture together.
 *
 * -----------------------------------------------------------------------
 * Account order (index → role):
 * -----------------------------------------------------------------------
 *
 *    0  pool                     (writable)          — AMM pool state
 *    1  user                     (signer, writable)  — initiator
 *    2  input mint               (readonly)          — what the user spends
 *    3  output mint              (readonly)          — what the user receives
 *    4  user input ATA           (writable)          — caller's ATA for inputMint
 *    5  user output ATA          (writable)          — caller's ATA for outputMint
 *    6  pool base vault          (writable)          — pool's ATA for base mint
 *    7  pool quote vault         (writable)          — pool's ATA for quote mint
 *    8  base mint                (readonly)          — pool's base side
 *    9  quote mint               (readonly)          — pool's quote side
 *   10  token program
 *   11  event-authority PDA      (readonly)          — CPI self-log authority
 *   12  PumpSwap program (self)                       — required by Anchor event CPI
 *
 * Positions 6/7/8/9 require information the builder does not currently have
 * (base/quote mints and vault PDAs for the pool). Until the live-sample
 * checkpoint clarifies which of these the program consumes and how, we
 * accept the pool address as a stand-in for positions 6–9. Callers that
 * already know the pool's base/quote mints can override by composing their
 * own Instruction; once the real recipe is confirmed, the params record
 * grows to accept them and the fallback is removed.
 *
 * Instruction data:
 *   [0..8]   discriminator  (hex `f8c69e91e17587c8` → `INSTRUCTION_DISCRIMINATORS.pumpSwapSwap`)
 *   [8..16]  inputAmount    u64 LE
 *   [16..24] minOutputAmount u64 LE
 */

import type { PublicKey } from '@ap3x/solana-core';
import type { Instruction, AccountMeta } from '@ap3x/solana-tx';
import { findProgramAddress } from '@ap3x/solana-tx';
import { PUMPFUN_PUMPSWAP_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import {
  concat,
  discHex,
  encodeU64LE,
  INSTRUCTION_DISCRIMINATORS,
} from './borsh.js';
import type { PumpSwapSwapParams } from './params.js';

/**
 * Derive the PumpSwap event-authority PDA.
 *
 * Pump.fun's bonding curve program uses the conventional
 * `[b"__event_authority"]` seed, and PumpSwap — being an Anchor program
 * sharing the same event-emission pattern — is ASSUMED to follow suit.
 * Verify during the Helius-keyed fixture capture; if PumpSwap uses a
 * different seed, update here alongside the roundtrip fixture.
 *
 * Kept private to this file (not exported from `account-derivation.ts`)
 * because the shared module advertises bonding-curve seeds. Promoting this
 * into the shared surface should wait until the seed is verified.
 */
function derivePumpSwapEventAuthorityPda(): {
  address: PublicKey;
  bump: number;
} {
  const seeds = [new TextEncoder().encode('__event_authority')];
  return findProgramAddress(seeds, PUMPFUN_PUMPSWAP_PROGRAM_ID);
}

/**
 * Build the raw `Instruction` for a PumpSwap AMM Swap.
 *
 * Pure — returns `{ programId, keys, data }`. Callers hand the result to
 * `@ap3x/solana-tx.assemble` along with a signer list that covers `user`.
 *
 * Validates amount semantics and direction:
 *   - `inputAmount > 0n`        — zero-input swaps are never useful.
 *   - `minOutputAmount >= 0n`   — negative floors are meaningless; `0n` is
 *                                  valid ("market swap at any price").
 *   - `inputMint != outputMint` — a swap between identical mints would be
 *                                  a no-op at best and a fee drain at worst.
 *
 * @throws TypeError on any of the validation failures above.
 */
export function buildPumpSwapSwap(params: PumpSwapSwapParams): Instruction {
  if (params.inputAmount <= 0n) {
    throw new TypeError('PumpSwapSwapParams.inputAmount must be > 0');
  }
  if (params.minOutputAmount < 0n) {
    throw new TypeError('PumpSwapSwapParams.minOutputAmount must be >= 0');
  }
  if (params.inputMint.equals(params.outputMint)) {
    throw new TypeError(
      'PumpSwapSwapParams.inputMint must differ from outputMint',
    );
  }

  const { address: eventAuthority } = derivePumpSwapEventAuthorityPda();

  // Pool base/quote vaults + base/quote mints at positions 6-9 are part of
  // the unverified layout. Without a captured fixture we don't know which
  // side of the pool is "base" vs. "quote", so we reuse the pool address
  // as a placeholder for these four slots. This keeps the shape test's
  // positional assertions meaningful (account-list length + caller-supplied
  // pubkeys at their documented indexes) without fabricating vault PDAs
  // that would later silently drift. See the file-top ASSUMPTION block.
  const poolPlaceholder = params.pool;

  const keys: AccountMeta[] = [
    { pubkey: params.pool, isSigner: false, isWritable: true }, //              0
    { pubkey: params.user, isSigner: true, isWritable: true }, //               1
    { pubkey: params.inputMint, isSigner: false, isWritable: false }, //        2
    { pubkey: params.outputMint, isSigner: false, isWritable: false }, //       3
    { pubkey: params.userInputAccount, isSigner: false, isWritable: true }, //  4
    { pubkey: params.userOutputAccount, isSigner: false, isWritable: true }, // 5
    { pubkey: poolPlaceholder, isSigner: false, isWritable: true }, //          6 pool base vault (placeholder)
    { pubkey: poolPlaceholder, isSigner: false, isWritable: true }, //          7 pool quote vault (placeholder)
    { pubkey: poolPlaceholder, isSigner: false, isWritable: false }, //         8 base mint (placeholder)
    { pubkey: poolPlaceholder, isSigner: false, isWritable: false }, //         9 quote mint (placeholder)
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, //       10
    { pubkey: eventAuthority, isSigner: false, isWritable: false }, //         11
    { pubkey: PUMPFUN_PUMPSWAP_PROGRAM_ID, isSigner: false, isWritable: false }, // 12
  ];

  const data = concat(
    discHex(INSTRUCTION_DISCRIMINATORS.pumpSwapSwap),
    encodeU64LE(params.inputAmount),
    encodeU64LE(params.minOutputAmount),
  );

  return {
    programId: PUMPFUN_PUMPSWAP_PROGRAM_ID,
    keys,
    data,
  };
}

/**
 * Wrapped SOL helpers: the SPL Token instructions for funding a WSOL account
 * from native SOL and closing it back.
 *
 *   SyncNative    data = [17]   keys = [account (w)]
 *   CloseAccount  data = [9]    keys = [account (w), destination (w), owner (s)]
 */

import { PublicKey } from '@ap3x/solana-core';

import type { Instruction } from './ata';
import { TOKEN_PROGRAM_ID } from './program-ids';

/** The wrapped SOL mint (SPL Token program). */
export const NATIVE_MINT = /* @__PURE__ */ PublicKey.fromBase58('So11111111111111111111111111111111111111112');

const SYNC_NATIVE = 17;
const CLOSE_ACCOUNT = 9;

/** Sets a WSOL account's token amount to its lamports above rent, after a SOL transfer into it. */
export function syncNativeIx(account: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID): Instruction {
  return {
    programId: tokenProgramId,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: new Uint8Array([SYNC_NATIVE]),
  };
}

/** Closes a token account, sending its lamports (all of it, for WSOL) to `destination`. */
export function closeAccountIx(
  account: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): Instruction {
  return {
    programId: tokenProgramId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: new Uint8Array([CLOSE_ACCOUNT]),
  };
}

/**
 * Program-upgrade check. The builders and decoders here follow the vendored
 * IDLs, which were checked against a specific deployment of each program.
 * If a program has been redeployed since, its accounts or instructions may
 * have changed under us: callers should stop building trades (a kill switch)
 * until the IDLs are re-verified, while decoding keeps running.
 *
 * Upgradeable programs (BPF Loader Upgradeable):
 *   Program      data = [u32 LE = 2][programData: pubkey]
 *   ProgramData  data = [u32 LE = 3][lastDeploySlot: u64 LE][authority: Option<pubkey>][ELF…]
 */

import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_FEES_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';
import { AccountLayoutError, fetchAccountData, fetchAccountDataBatch } from './curve/state.js';

export interface VerifiedDeploy {
  programId: PublicKey;
  /** Last-deployed slot of the build the vendored IDLs were verified against. */
  slot: bigint;
}

/**
 * Verified 2026-10-03: mainnet simulation of `buy_exact_sol_in`, and of
 * `buy_exact_quote_in_v2` + `sell_v2` through WSOL, passed against these
 * deployments, and a live Pump/PumpSwap stream decoded with no failures.
 * Update these after re-verifying a redeploy.
 */
export const VERIFIED_DEPLOYS: readonly VerifiedDeploy[] = [
  { programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID, slot: 452_654_932n },
  { programId: PUMPFUN_PUMPSWAP_PROGRAM_ID, slot: 452_654_882n },
  { programId: PUMPFUN_FEES_PROGRAM_ID, slot: 452_655_002n },
];

const PROGRAM_TAG = 2;
const PROGRAM_DATA_TAG = 3;

/** The slot `programId` was last deployed at. Reads only the ProgramData header, not the ELF. */
export async function programDeploySlot(rpcPool: RpcPool, programId: PublicKey): Promise<bigint> {
  const program = await fetchAccountData(rpcPool, programId, 'Program');
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
  if (program.length < 36 || view.getUint32(0, true) !== PROGRAM_TAG) {
    throw new AccountLayoutError('Program', program, 'not an upgradeable program account');
  }
  const programData = PublicKey.fromBytes(program.slice(4, 36));
  const response = (await rpcPool.call('getAccountInfo', [
    programData.toBase58(),
    { encoding: 'base64', dataSlice: { offset: 0, length: 12 } },
  ])) as { value: { data: [string, string] } | null };
  const header = response?.value?.data ? Uint8Array.from(Buffer.from(response.value.data[0], 'base64')) : new Uint8Array();
  const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 12 || h.getUint32(0, true) !== PROGRAM_DATA_TAG) {
    throw new AccountLayoutError('ProgramData', header, 'not a ProgramData account');
  }
  return h.getBigUint64(4, true);
}

export interface UpgradeCheck {
  programId: PublicKey;
  verifiedSlot: bigint;
  deployedSlot: bigint;
  /** Redeployed since the IDLs were verified: stop building trades for it. */
  upgraded: boolean;
}

export async function checkProgramUpgrades(
  rpcPool: RpcPool,
  verified: readonly VerifiedDeploy[] = VERIFIED_DEPLOYS,
): Promise<UpgradeCheck[]> {
  const requested = verified.map(entry => ({ ...entry })), checks: UpgradeCheck[] = [];
  // Preserve arbitrary caller lists without exceeding the RPC's 100-account limit.
  for (let start = 0; start < requested.length; start += 100) {
    const batch = requested.slice(start, start + 100);
    const programs = await fetchAccountDataBatch(rpcPool, batch.map(entry => ({ address: entry.programId, label: 'Program' })));
    const addresses = programs.map(program => {
      if (program.length < 36 || new DataView(program.buffer, program.byteOffset, program.byteLength).getUint32(0, true) !== PROGRAM_TAG)
        throw new AccountLayoutError('Program', program, 'not an upgradeable program account');
      return { address: PublicKey.fromBytes(program.slice(4, 36)), label: 'ProgramData' };
    });
    const headers = await fetchAccountDataBatch(rpcPool, addresses, { offset: 0, length: 12 });
    for (const [index, header] of headers.entries()) {
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      if (header.length < 12 || view.getUint32(0, true) !== PROGRAM_DATA_TAG)
        throw new AccountLayoutError('ProgramData', header, 'not a ProgramData account');
      const deployedSlot = view.getBigUint64(4, true), entry = batch[index]!;
      checks.push({ programId: entry.programId, verifiedSlot: entry.slot, deployedSlot, upgraded: deployedSlot !== entry.slot });
    }
  }
  return checks;
}

import { describe, expect, it } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { checkProgramUpgrades, programDeploySlot, VERIFIED_DEPLOYS } from './program-upgrade.js';

const key = (n: number) => PublicKey.fromBytes(new Uint8Array(32).fill(n));
const b64 = (bytes: Uint8Array) => [Buffer.from(bytes).toString('base64'), 'base64'];

function programAccount(programData: PublicKey, tag = 2) {
  const d = new Uint8Array(36);
  new DataView(d.buffer).setUint32(0, tag, true);
  d.set(programData.toBuffer(), 4);
  return d;
}
function programDataHeader(slot: bigint, tag = 3) {
  const d = new Uint8Array(12);
  const v = new DataView(d.buffer);
  v.setUint32(0, tag, true);
  v.setBigUint64(4, slot, true);
  return d;
}

/** Fake pool: programId → programData key, programData → header. Records dataSlice use. */
function pool(accounts: Record<string, Uint8Array | null>) {
  const calls: Array<{ address: string; slice: unknown }> = [];
  return {
    calls,
    call: async (_m: string, [address, opts]: [string, { dataSlice?: unknown }]) => {
      calls.push({ address, slice: opts.dataSlice });
      const data = accounts[address];
      return { value: data ? { data: b64(data) } : null };
    },
  } as never as { calls: typeof calls; call: (...a: unknown[]) => Promise<unknown> };
}

describe('programDeploySlot', () => {
  it('reads the slot from the ProgramData header, fetching only 12 bytes of it', async () => {
    const p = pool({ [key(1).toBase58()]: programAccount(key(2)), [key(2).toBase58()]: programDataHeader(123n) });
    expect(await programDeploySlot(p as never, key(1))).toBe(123n);
    expect(p.calls[1]).toEqual({ address: key(2).toBase58(), slice: { offset: 0, length: 12 } });
  });

  it('refuses non-upgradeable or malformed accounts', async () => {
    await expect(programDeploySlot(pool({ [key(1).toBase58()]: programAccount(key(2), 9) }) as never, key(1))).rejects.toThrow(/upgradeable/);
    await expect(
      programDeploySlot(pool({ [key(1).toBase58()]: programAccount(key(2)), [key(2).toBase58()]: programDataHeader(1n, 1) }) as never, key(1)),
    ).rejects.toThrow(/ProgramData/);
    await expect(programDeploySlot(pool({ [key(1).toBase58()]: programAccount(key(2)), [key(2).toBase58()]: null }) as never, key(1))).rejects.toThrow(
      /ProgramData/,
    );
  });
});

describe('checkProgramUpgrades', () => {
  it('flags only programs redeployed since verification', async () => {
    const p = pool({
      [key(1).toBase58()]: programAccount(key(11)),
      [key(11).toBase58()]: programDataHeader(100n),
      [key(2).toBase58()]: programAccount(key(12)),
      [key(12).toBase58()]: programDataHeader(250n),
    });
    const checks = await checkProgramUpgrades(p as never, [
      { programId: key(1), slot: 100n },
      { programId: key(2), slot: 200n },
    ]);
    expect(checks.map((c) => [c.deployedSlot, c.upgraded])).toEqual([
      [100n, false],
      [250n, true],
    ]);
  });

  it('covers Pump, PumpSwap and Pump Fees by default', () => {
    expect(VERIFIED_DEPLOYS.map((d) => d.programId.toBase58())).toEqual([
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
    ]);
  });
});

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
  const calls: Array<{ address: string | string[]; slice: unknown }> = [];
  return {
    calls,
    call: async (_m: string, [address, opts]: [string | string[], { dataSlice?: unknown }]) => {
      calls.push({ address, slice: opts.dataSlice });
      if (Array.isArray(address)) return { value: address.map(a => accounts[a] ? { data: b64(accounts[a]!) } : null) };
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
  it('fails closed on malformed batched deployment accounts and re-reads on each check', async () => {
    const accounts = { [key(1).toBase58()]: programAccount(key(11)), [key(11).toBase58()]: programDataHeader(100n) };
    const p = pool(accounts), verified = [{ programId: key(1), slot: 100n }];
    expect((await checkProgramUpgrades(p as never, verified))[0]!.upgraded).toBe(false);
    accounts[key(11).toBase58()] = programDataHeader(101n);
    expect((await checkProgramUpgrades(p as never, verified))[0]!.upgraded).toBe(true);
    accounts[key(11).toBase58()] = programDataHeader(101n, 1);
    await expect(checkProgramUpgrades(p as never, verified)).rejects.toThrow('ProgramData');
    accounts[key(1).toBase58()] = programAccount(key(11), 9);
    await expect(checkProgramUpgrades(p as never, verified)).rejects.toThrow('upgradeable');
  });
  it('preserves caller order beyond one hundred programs without oversized RPC requests', async () => {
    const verified = Array.from({ length: 101 }, (_, i) => ({ programId: key(i), slot: 100n }));
    const accounts = Object.fromEntries(verified.map(entry => [entry.programId.toBase58(), programAccount(key(200))]));
    accounts[key(200).toBase58()] = programDataHeader(100n);
    const p = pool(accounts), checks = await checkProgramUpgrades(p as never, verified);
    expect(checks.map(c => c.programId.toBase58())).toEqual(verified.map(c => c.programId.toBase58()));
    expect(checks.every(c => !c.upgraded)).toBe(true);
    expect(p.calls.map(c => (c.address as string[]).length)).toEqual([100, 100, 1, 1]);
  });
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
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]!.address).toEqual([key(1).toBase58(), key(2).toBase58()]);
    expect(p.calls[1]).toEqual({ address: [key(11).toBase58(), key(12).toBase58()], slice: { offset: 0, length: 12 } });
  });

  it('covers Pump, PumpSwap and Pump Fees by default', () => {
    expect(VERIFIED_DEPLOYS.map((d) => d.programId.toBase58())).toEqual([
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
    ]);
  });
});

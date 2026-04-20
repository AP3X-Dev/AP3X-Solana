import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { WalletReserveBreach } from '@ap3x/solana-vault';
import type { WalletHandle } from '@ap3x/solana-vault';
import { Executor } from '@ap3x/solana-executor';
import type { Submitter } from '@ap3x/solana-executor';

describe('gate 4: vault reserve breach surfaces as rejected', () => {
  it('returns rejected with code=reserve_breach when WalletHandle.sign throws WalletReserveBreach', async () => {
    const address = PublicKey.fromBase58('11111111111111111111111111111112');
    const handle: WalletHandle = {
      address,
      role: 'main',
      sign: vi.fn(async () => {
        throw new WalletReserveBreach({
          role: 'hot',
          projectedBalance: 500000n,
          reserveLamports: 1000000n,
        });
      }),
      signTransaction: vi.fn(async () => {
        throw new WalletReserveBreach({
          role: 'hot',
          projectedBalance: 500000n,
          reserveLamports: 1000000n,
        });
      }),
    } as any;

    const fakeRpc: any = {
      pinForWrite: () => fakeRpc,
      call: vi.fn(async (m: string) => {
        if (m === 'getLatestBlockhash') return { value: { blockhash: 'AAA' } };
        return null;
      }),
    };

    // The executor catches WalletReserveBreach from the `assemble` call.
    // Inject a fake assembler that throws WalletReserveBreach to simulate
    // the vault guard firing during transaction signing.
    const fakeAssembler = vi.fn(async (_opts: any) => {
      throw new WalletReserveBreach({
        role: 'hot',
        projectedBalance: 500000n,
        reserveLamports: 1000000n,
      });
    });

    const fakeSubmitter: Submitter = {
      name: 'fake-rpc',
      kind: 'rpc',
      submit: vi.fn(async () => ({
        kind: 'tx' as const,
        signature: 'sig',
        submitterUsed: 'fake-rpc',
      })),
      health: () => ({ state: 'healthy' }),
    };

    const exec = new Executor({
      rpcPool: fakeRpc,
      resolveWallet: async () => handle,
      feeEstimator: { tier: () => 1 },
      assemble: fakeAssembler,
      submitters: [fakeSubmitter],
      defaultSubmitter: 'rpc',
    } as any);

    const result = await exec.submit({
      intentId: 'i1',
      wallet: 'main',
      instructions: [],
      feeTier: 'med',
      deadline: Date.now() + 5000,
      computeBudgetHint: 200_000,
    } as any);

    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.error.code).toBe('reserve_breach');
    }
  });
});

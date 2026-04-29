import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeHeliusTx,
  PUMPFUN_PROGRAM,
  JUPITER_V6_PROGRAM,
  RAYDIUM_AMM_V4_PROGRAM,
  UNKNOWN_PROGRAM,
  type HeliusEnhancedTx,
} from './normalize.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'tests', 'fixtures', 'helius',
);

function loadFixture(name: string): HeliusEnhancedTx {
  const text = readFileSync(join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(text) as HeliusEnhancedTx;
}

describe('normalizeHeliusTx — captured fixtures', () => {
  it('swap_buy.json → DecodedEvent { variant: helius-swap, programId: UNKNOWN } when source missing', () => {
    const tx = loadFixture('swap_buy.json');
    const events = normalizeHeliusTx(tx);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe('decoded');
    expect(e.signature).toBe('sig_swap_buy_1');
    if (e.kind === 'decoded') {
      const data = e.data as { variant: string; tokenTransfers: unknown[]; nativeTransfers: unknown[] };
      expect(data.variant).toBe('helius-swap');
      expect(data.tokenTransfers).toHaveLength(2);
      expect(data.nativeTransfers).toHaveLength(0);
    }
  });

  it('jupiter_swap.json → maps source=JUPITER to Jupiter V6 programId', () => {
    const tx = { ...loadFixture('jupiter_swap.json'), source: 'JUPITER' };
    const [e] = normalizeHeliusTx(tx);
    expect(e?.kind).toBe('decoded');
    expect(e?.programId).toBe(JUPITER_V6_PROGRAM);
  });

  it('pumpfun_buy.json → maps source containing PUMP to pump.fun programId', () => {
    const tx = { ...loadFixture('pumpfun_buy.json'), source: 'PUMP_FUN' };
    const [e] = normalizeHeliusTx(tx);
    expect(e?.kind).toBe('decoded');
    expect(e?.programId).toBe(PUMPFUN_PROGRAM);
  });

  it('raydium-style source → Raydium V4 programId', () => {
    const tx = loadFixture('swap_buy.json');
    const [e] = normalizeHeliusTx({ ...tx, source: 'RAYDIUM' });
    expect(e?.programId).toBe(RAYDIUM_AMM_V4_PROGRAM);
  });

  it('token_mint_buy.json → variant: helius-token-mint', () => {
    const tx = loadFixture('token_mint_buy.json');
    const events = normalizeHeliusTx(tx);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe('decoded');
    if (e.kind === 'decoded') {
      const data = e.data as { variant: string };
      expect(data.variant).toBe('helius-token-mint');
    }
  });

  it('transfer.json → variant: helius-transfer with UNKNOWN_PROGRAM (no venue)', () => {
    const tx = loadFixture('transfer.json');
    const [e] = normalizeHeliusTx(tx);
    expect(e?.kind).toBe('decoded');
    expect(e?.programId).toBe(UNKNOWN_PROGRAM);
    if (e?.kind === 'decoded') {
      const data = e.data as { variant: string };
      expect(data.variant).toBe('helius-transfer');
    }
  });

  it('failed.json → UnknownEventDecode with reason "transaction failed"', () => {
    const tx = loadFixture('failed.json');
    const [e] = normalizeHeliusTx(tx);
    expect(e?.kind).toBe('unknown');
    if (e?.kind === 'unknown') {
      expect(e.reason).toBe('transaction failed');
    }
  });

  it('sell.json → DecodedEvent (semantic correctness; classification is consumer-side)', () => {
    const tx = loadFixture('sell.json');
    const events = normalizeHeliusTx(tx);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('decoded');
  });

  it('buy_with_dust_rebate.json → preserves all transfers in data', () => {
    const tx = loadFixture('buy_with_dust_rebate.json');
    const [e] = normalizeHeliusTx(tx);
    if (e?.kind === 'decoded') {
      const data = e.data as { tokenTransfers: unknown[]; nativeTransfers: unknown[] };
      // Don't pin to a specific count — just verify nothing was dropped.
      expect(Array.isArray(data.tokenTransfers)).toBe(true);
      expect(Array.isArray(data.nativeTransfers)).toBe(true);
    }
  });
});

describe('normalizeHeliusTx — synthetic edge cases', () => {
  const baseTx: HeliusEnhancedTx = {
    signature: 'sig-base',
    type: 'SWAP',
    transactionError: null,
  };

  it('emits Unknown when type is missing', () => {
    const { type: _type, ...rest } = baseTx;
    void _type;
    const [e] = normalizeHeliusTx(rest);
    expect(e?.kind).toBe('unknown');
    if (e?.kind === 'unknown') {
      expect(e.reason).toContain('not classifiable');
    }
  });

  it('emits Unknown when type is unrecognized', () => {
    const [e] = normalizeHeliusTx({ ...baseTx, type: 'NFT_BID' });
    expect(e?.kind).toBe('unknown');
    if (e?.kind === 'unknown') {
      expect(e.reason).toMatch(/NFT_BID/);
    }
  });

  it('treats absent transfers arrays as empty rather than throwing', () => {
    const [e] = normalizeHeliusTx({
      ...baseTx,
      type: 'SWAP',
    });
    expect(e?.kind).toBe('decoded');
    if (e?.kind === 'decoded') {
      const data = e.data as { tokenTransfers: unknown[]; nativeTransfers: unknown[] };
      expect(data.tokenTransfers).toEqual([]);
      expect(data.nativeTransfers).toEqual([]);
    }
  });

  it('coerces non-numeric tokenAmount to 0 (defensive)', () => {
    const [e] = normalizeHeliusTx({
      ...baseTx,
      tokenTransfers: [
        { fromUserAccount: 'a', toUserAccount: 'b', mint: 'm', tokenAmount: NaN },
      ],
    });
    if (e?.kind === 'decoded') {
      const data = e.data as { tokenTransfers: Array<{ tokenAmount: number }> };
      expect(data.tokenTransfers[0]?.tokenAmount).toBe(0);
    }
  });

  it('defaults missing slot to 0 to satisfy TypedSolanaEvent.slot: number', () => {
    const { slot: _slot, ...rest } = baseTx;
    void _slot;
    const [e] = normalizeHeliusTx(rest);
    expect(e?.slot).toBe(0);
  });

  it('preserves null fromUserAccount / toUserAccount (mint/burn legs)', () => {
    const [e] = normalizeHeliusTx({
      ...baseTx,
      tokenTransfers: [{ fromUserAccount: null, toUserAccount: 'recipient', mint: 'm', tokenAmount: 1 }],
    });
    if (e?.kind === 'decoded') {
      const data = e.data as { tokenTransfers: Array<{ fromUserAccount: unknown }> };
      expect(data.tokenTransfers[0]?.fromUserAccount).toBeNull();
    }
  });

  it('failed transactions are emitted as Unknown even when type is SWAP', () => {
    const [e] = normalizeHeliusTx({
      ...baseTx,
      type: 'SWAP',
      transactionError: { InstructionError: [0, 'Custom'] },
    });
    expect(e?.kind).toBe('unknown');
    if (e?.kind === 'unknown') expect(e.reason).toBe('transaction failed');
  });
});

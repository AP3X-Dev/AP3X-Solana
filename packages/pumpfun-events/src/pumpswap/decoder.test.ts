import { describe, it, expect } from 'vitest';
import { pumpSwapDecoder } from './decoder.js';
import type { ProgramLogChunk } from '@ap3x/solana-events';
import { PUMPFUN_PUMPSWAP_PROGRAM_ID } from '../program-ids.js';
import { PUMPSWAP_EVENT_DISCRIMINATORS } from './discriminator.js';

function chunk(dataPayloads: Uint8Array[]): ProgramLogChunk {
  return {
    programId: PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58(),
    depth: 1,
    success: true,
    logs: [],
    dataPayloads,
    children: [],
    rawLines: [],
  };
}

function discBytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('pumpSwapDecoder', () => {
  it('returns unknown when no data payload', () => {
    const r = pumpSwapDecoder.decode(chunk([]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toBe('no-data-payload');
  });

  it('returns unknown when payload too short for discriminator', () => {
    const r = pumpSwapDecoder.decode(chunk([new Uint8Array([1, 2, 3])]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toBe('truncated-data');
  });

  it('returns unknown-discriminator for unrecognized 8-byte prefix', () => {
    const payload = new Uint8Array(16);
    payload.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);
    const r = pumpSwapDecoder.decode(chunk([payload]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toMatch(/^unknown-discriminator:/);
  });

  it('returns borsh-parse-error on truncated Swap payload', () => {
    const disc = discBytesOf(PUMPSWAP_EVENT_DISCRIMINATORS.SwapEvent);
    // 3 bytes body — nowhere near enough for 4 pubkeys + reserves
    const payload = new Uint8Array([...disc, 0, 1, 2]);
    const r = pumpSwapDecoder.decode(chunk([payload]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toMatch(/^borsh-parse-error:swap:/);
  });

  it('returns borsh-parse-error on truncated AddLiquidity payload', () => {
    const disc = discBytesOf(PUMPSWAP_EVENT_DISCRIMINATORS.AddLiquidityEvent);
    const payload = new Uint8Array([...disc, 0, 1, 2]);
    const r = pumpSwapDecoder.decode(chunk([payload]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toMatch(/^borsh-parse-error:add_liquidity:/);
  });

  it('returns borsh-parse-error on truncated RemoveLiquidity payload', () => {
    const disc = discBytesOf(PUMPSWAP_EVENT_DISCRIMINATORS.RemoveLiquidityEvent);
    const payload = new Uint8Array([...disc, 0, 1, 2]);
    const r = pumpSwapDecoder.decode(chunk([payload]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toMatch(/^borsh-parse-error:remove_liquidity:/);
  });

  it('returns borsh-parse-error on truncated Admin payload', () => {
    const disc = discBytesOf(PUMPSWAP_EVENT_DISCRIMINATORS.AdminSetParamsEvent);
    const payload = new Uint8Array([...disc, 0, 1, 2]);
    const r = pumpSwapDecoder.decode(chunk([payload]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown')
      expect(r.reason).toMatch(/^borsh-parse-error:admin_set_params:/);
  });

  it('never throws — all error paths return UnknownEventDecode', () => {
    // No data payload
    expect(() => pumpSwapDecoder.decode(chunk([]))).not.toThrow();
    // Empty buffer
    expect(() => pumpSwapDecoder.decode(chunk([new Uint8Array()]))).not.toThrow();
    // Under 8 bytes (truncated-data path)
    expect(() => pumpSwapDecoder.decode(chunk([new Uint8Array([1, 2, 3, 4])]))).not.toThrow();
    // Unknown 8-byte discriminator followed by garbage body
    const unknownPrefix = new Uint8Array(21);
    unknownPrefix[0] = 0xff;
    expect(() => pumpSwapDecoder.decode(chunk([unknownPrefix]))).not.toThrow();
    // Each known discriminator + truncated body should surface borsh-parse-error
    for (const hex of Object.values(PUMPSWAP_EVENT_DISCRIMINATORS)) {
      const disc = discBytesOf(hex);
      const truncated = new Uint8Array([...disc, 0xff]);
      expect(() => pumpSwapDecoder.decode(chunk([truncated]))).not.toThrow();
    }
  });
});

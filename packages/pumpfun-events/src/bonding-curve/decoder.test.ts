import { describe, it, expect } from 'vitest';
import { bondingCurveDecoder } from './decoder.js';
import type { ProgramLogChunk } from '@ap3x/solana-events';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '../program-ids.js';

function chunk(dataPayloads: Uint8Array[]): ProgramLogChunk {
  return {
    programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58(),
    depth: 1,
    success: true,
    logs: [],
    dataPayloads,
    children: [],
    rawLines: [],
  };
}

describe('bondingCurveDecoder', () => {
  it('returns unknown when no data payload', () => {
    const r = bondingCurveDecoder.decode(chunk([]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toBe('no-data-payload');
  });

  it('returns unknown when payload too short for discriminator', () => {
    const r = bondingCurveDecoder.decode(chunk([new Uint8Array([1, 2, 3])]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toBe('truncated-data');
  });

  it('returns unknown-discriminator for unrecognized 8-byte prefix', () => {
    const payload = new Uint8Array(16);
    payload.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);
    const r = bondingCurveDecoder.decode(chunk([payload]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toMatch(/^unknown-discriminator:/);
  });

  it('returns borsh-parse-error on truncated Trade payload', () => {
    // Valid Trade discriminator but truncated body — should surface a parse error
    const discHex = 'bddb7fd34ee661ee';
    const disc = new Uint8Array(8);
    for (let i = 0; i < 8; i++) disc[i] = parseInt(discHex.slice(i * 2, i * 2 + 2), 16);
    const payload = new Uint8Array([...disc, 0, 1, 2]); // 3 bytes body — not enough for any Trade field
    const r = bondingCurveDecoder.decode(chunk([payload]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toMatch(/^borsh-parse-error:trade:/);
  });

  it('never throws — all error paths return UnknownEventDecode', () => {
    // No data payload
    expect(() => bondingCurveDecoder.decode(chunk([]))).not.toThrow();
    // Empty buffer
    expect(() => bondingCurveDecoder.decode(chunk([new Uint8Array()]))).not.toThrow();
    // Under 8 bytes (truncated-data path)
    expect(() => bondingCurveDecoder.decode(chunk([new Uint8Array([1, 2, 3, 4])]))).not.toThrow();
    // Unknown 8-byte discriminator followed by garbage body
    const unknownPrefix = new Uint8Array(21);
    unknownPrefix[0] = 0xff;
    expect(() => bondingCurveDecoder.decode(chunk([unknownPrefix]))).not.toThrow();
    // Valid Trade discriminator + truncated body (borsh-parse-error path)
    const discHex = 'bddb7fd34ee661ee';
    const tradeDisc = new Uint8Array(8);
    for (let i = 0; i < 8; i++) tradeDisc[i] = parseInt(discHex.slice(i * 2, i * 2 + 2), 16);
    const truncatedTrade = new Uint8Array([...tradeDisc, 0, 1, 2]);
    expect(() => bondingCurveDecoder.decode(chunk([truncatedTrade]))).not.toThrow();
    // Valid Create discriminator + truncated body
    const createHex = '1b72a94ddeeb6376';
    const createDisc = new Uint8Array(8);
    for (let i = 0; i < 8; i++) createDisc[i] = parseInt(createHex.slice(i * 2, i * 2 + 2), 16);
    const truncatedCreate = new Uint8Array([...createDisc, 0xff]);
    expect(() => bondingCurveDecoder.decode(chunk([truncatedCreate]))).not.toThrow();
  });
});

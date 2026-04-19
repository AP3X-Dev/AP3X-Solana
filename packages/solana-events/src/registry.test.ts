import { describe, it, expect } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';

import { parseLogs } from './parse-logs';
import type { ProgramLogChunk } from './parse-logs';
import {
  EventDecoderRegistry,
  type ProgramDecoder,
  type UnknownEventDecode,
} from './registry';

const TOKEN_B58 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_B58 = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const METAPLEX_B58 = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

const TOKEN = PublicKey.fromBase58(TOKEN_B58);
const ATA = PublicKey.fromBase58(ATA_B58);
const METAPLEX = PublicKey.fromBase58(METAPLEX_B58);

interface TokenEvent {
  type: 'transfer';
  amount: number;
}

const tokenDecoder: ProgramDecoder<TokenEvent> = {
  programId: TOKEN,
  decode(chunk: ProgramLogChunk): TokenEvent {
    // Fake decoder — parse the first log line as "amount=<n>".
    const match = chunk.logs[0]?.match(/amount=(\d+)/);
    if (!match) {
      throw new Error('no amount in log');
    }
    return { type: 'transfer', amount: Number(match[1]) };
  },
};

describe('EventDecoderRegistry', () => {
  it('decodes a registered program', () => {
    const tx = parseLogs([
      `Program ${TOKEN_B58} invoke [1]`,
      `Program log: amount=42`,
      `Program ${TOKEN_B58} success`,
    ]);

    const registry = new EventDecoderRegistry().register(TOKEN, tokenDecoder);
    const stream = registry.decode(tx);

    expect(stream.events).toHaveLength(1);
    expect(stream.events[0]).toEqual({
      kind: 'decoded',
      programId: TOKEN_B58,
      data: { type: 'transfer', amount: 42 },
    });
    expect(stream.unknown).toEqual([]);
    expect(stream.parseErrors).toEqual([]);
  });

  it('accepts string form when registering', () => {
    const tx = parseLogs([
      `Program ${TOKEN_B58} invoke [1]`,
      `Program log: amount=7`,
      `Program ${TOKEN_B58} success`,
    ]);

    const registry = new EventDecoderRegistry().register(
      TOKEN_B58,
      tokenDecoder,
    );
    const stream = registry.decode(tx);
    expect(stream.events[0]).toMatchObject({ kind: 'decoded' });
  });

  it('emits UnknownEventDecode when no decoder is registered', () => {
    const tx = parseLogs([
      `Program ${ATA_B58} invoke [1]`,
      `Program ${ATA_B58} success`,
    ]);

    const registry = new EventDecoderRegistry();
    const stream = registry.decode(tx);

    expect(stream.events).toHaveLength(1);
    const event = stream.events[0] as UnknownEventDecode;
    expect(event.kind).toBe('unknown');
    expect(event.programId).toBe(ATA_B58);
    expect(event.reason).toBe('no decoder registered');
    expect(event.rawLines).toBeDefined();
    expect(stream.unknown).toHaveLength(1);
    expect(stream.unknown[0]).toBe(event);
  });

  it('catches decoder exceptions and surfaces them as unknown', () => {
    const tx = parseLogs([
      `Program ${TOKEN_B58} invoke [1]`,
      `Program log: no amount here`,
      `Program ${TOKEN_B58} success`,
    ]);

    const registry = new EventDecoderRegistry().register(TOKEN, tokenDecoder);
    const stream = registry.decode(tx);

    expect(stream.events).toHaveLength(1);
    const event = stream.events[0] as UnknownEventDecode;
    expect(event.kind).toBe('unknown');
    expect(event.programId).toBe(TOKEN_B58);
    expect(event.reason).toMatch(/decoder threw: no amount in log/);
    expect(stream.unknown).toHaveLength(1);
  });

  it('handles decoders returning explicit UnknownEventDecode', () => {
    const ambiguousDecoder: ProgramDecoder<TokenEvent> = {
      programId: TOKEN,
      decode() {
        return {
          kind: 'unknown',
          programId: TOKEN_B58,
          reason: 'unknown variant',
        };
      },
    };

    const tx = parseLogs([
      `Program ${TOKEN_B58} invoke [1]`,
      `Program ${TOKEN_B58} success`,
    ]);

    const registry = new EventDecoderRegistry().register(
      TOKEN,
      ambiguousDecoder,
    );
    const stream = registry.decode(tx);

    expect(stream.events).toHaveLength(1);
    const event = stream.events[0] as UnknownEventDecode;
    expect(event.kind).toBe('unknown');
    expect(event.reason).toBe('unknown variant');
    expect(event.rawLines).toBeDefined();
    expect(stream.unknown[0]).toBe(event);
  });

  it('walks nested CPIs and decodes each program independently', () => {
    const tx = parseLogs([
      `Program ${TOKEN_B58} invoke [1]`,
      `Program log: amount=100`,
      `Program ${ATA_B58} invoke [2]`,
      `Program ${METAPLEX_B58} invoke [3]`,
      `Program ${METAPLEX_B58} success`,
      `Program ${ATA_B58} success`,
      `Program ${TOKEN_B58} success`,
    ]);

    // ATA has a real decoder returning a marker; METAPLEX has none.
    const ataDecoder: ProgramDecoder<{ type: 'ata' }> = {
      programId: ATA,
      decode() {
        return { type: 'ata' };
      },
    };

    const registry = new EventDecoderRegistry()
      .register(TOKEN, tokenDecoder)
      .register(ATA, ataDecoder);

    const stream = registry.decode(tx);

    expect(stream.events).toHaveLength(3);
    // DFS order: token (root) first, then ata (middle), then metaplex (leaf)
    expect(stream.events[0]).toMatchObject({
      kind: 'decoded',
      programId: TOKEN_B58,
      data: { type: 'transfer', amount: 100 },
    });
    expect(stream.events[1]).toMatchObject({
      kind: 'decoded',
      programId: ATA_B58,
      data: { type: 'ata' },
    });
    expect(stream.events[2]).toMatchObject({
      kind: 'unknown',
      programId: METAPLEX_B58,
      reason: 'no decoder registered',
    });
    expect(stream.unknown).toHaveLength(1);
    expect(stream.unknown[0]?.programId).toBe(METAPLEX_B58);
  });

  it('forwards parseErrors from the underlying transaction log', () => {
    const tx = parseLogs([`Program ${TOKEN_B58} success`]);
    const registry = new EventDecoderRegistry();
    const stream = registry.decode(tx);
    expect(stream.parseErrors).toHaveLength(1);
    expect(stream.parseErrors[0]?.reason).toBe(
      'success without matching invoke',
    );
  });

  it('has() returns true only after registration', () => {
    const registry = new EventDecoderRegistry();
    expect(registry.has(TOKEN)).toBe(false);
    expect(registry.has(TOKEN_B58)).toBe(false);
    registry.register(TOKEN, tokenDecoder);
    expect(registry.has(TOKEN)).toBe(true);
    expect(registry.has(TOKEN_B58)).toBe(true);
  });

  it('register() returns this for chaining', () => {
    const registry = new EventDecoderRegistry();
    expect(registry.register(TOKEN, tokenDecoder)).toBe(registry);
  });

  it('register() replaces existing decoder for same programId', () => {
    const a: ProgramDecoder<{ who: 'a' }> = {
      programId: TOKEN,
      decode: () => ({ who: 'a' }),
    };
    const b: ProgramDecoder<{ who: 'b' }> = {
      programId: TOKEN,
      decode: () => ({ who: 'b' }),
    };
    const registry = new EventDecoderRegistry()
      .register(TOKEN, a)
      .register(TOKEN, b);

    const tx = parseLogs([
      `Program ${TOKEN_B58} invoke [1]`,
      `Program ${TOKEN_B58} success`,
    ]);
    const stream = registry.decode(tx);
    expect(stream.events[0]).toMatchObject({
      kind: 'decoded',
      data: { who: 'b' },
    });
  });

  it('catches non-Error throws from decoders', () => {
    const stringThrower: ProgramDecoder = {
      programId: TOKEN,
      decode() {
        throw 'naked string';
      },
    };
    const registry = new EventDecoderRegistry().register(TOKEN, stringThrower);
    const tx = parseLogs([
      `Program ${TOKEN_B58} invoke [1]`,
      `Program ${TOKEN_B58} success`,
    ]);
    const stream = registry.decode(tx);
    const event = stream.events[0] as UnknownEventDecode;
    expect(event.kind).toBe('unknown');
    expect(event.reason).toBe('decoder threw: naked string');
  });
});

import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { PublicKey } from '@ap3x/solana-core';
import type { SignalSource } from '../source.js';
import type { Signal } from '../signal.js';

export interface FixtureSignalSourceOpts {
  path: string;
  name?: string;
}

export class FixtureSignalSource extends EventEmitter implements SignalSource {
  readonly name: string;
  private readonly path: string;
  private aborted = false;

  constructor(opts: FixtureSignalSourceOpts) {
    super();
    this.path = opts.path;
    this.name = opts.name ?? 'fixture';
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener('abort', () => { this.aborted = true; });
    const gz = zlib.createGunzip();
    createReadStream(this.path).pipe(gz);
    const rl = readline.createInterface({ input: gz, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (this.aborted) break;
        if (!line.trim()) continue;
        const s = this.parseSignal(line);
        if (s) this.emit('signal', s);
      }
      // Emit 'end' asynchronously so callers can register listeners after
      // awaiting start(), matching the SignalSource contract. Aborted sources
      // do not emit 'end'.
      if (!this.aborted) {
        setImmediate(() => this.emit('end'));
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  async stop(): Promise<void> {
    this.aborted = true;
  }

  private parseSignal(line: string): Signal | null {
    const j = JSON.parse(line);
    if (typeof j.programId === 'string') j.programId = PublicKey.fromBase58(j.programId);
    if (j.raw && typeof j.raw.programId === 'string') {
      j.raw.programId = PublicKey.fromBase58(j.raw.programId);
    }
    return j as Signal;
  }
}

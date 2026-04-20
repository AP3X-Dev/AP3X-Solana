import { PublicKey } from '@ap3x/solana-core';

export class TruncatedBufferError extends Error {
  constructor(public readonly needed: number, public readonly available: number) {
    super(`truncated: needed ${needed} bytes, have ${available}`);
    this.name = 'TruncatedBufferError';
  }
}

export class BorshReader {
  private offset = 0;
  private view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  remaining(): number {
    return this.buf.length - this.offset;
  }

  private require(n: number): void {
    if (this.remaining() < n) {
      throw new TruncatedBufferError(n, this.remaining());
    }
  }

  readU8(): number {
    this.require(1);
    return this.view.getUint8(this.offset++);
  }

  readU16LE(): number {
    this.require(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readU32LE(): number {
    this.require(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU64LE(): bigint {
    this.require(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readI64LE(): bigint {
    this.require(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readFixedBytes(n: number): Uint8Array {
    this.require(n);
    const out = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  readVecU8(): Uint8Array {
    const len = this.readU32LE();
    return this.readFixedBytes(len);
  }

  readString(): string {
    const bytes = this.readVecU8();
    return new TextDecoder('utf-8').decode(bytes);
  }

  readPublicKey(): PublicKey {
    return PublicKey.fromBytes(this.readFixedBytes(32));
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  /** Reads an Anchor-style Option<T>: 1-byte tag (0 or 1) + optional T. */
  readOption<T>(inner: (r: BorshReader) => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return inner(this);
    throw new Error(`invalid option tag ${tag}`);
  }
}

// Convenience functional exports for one-off reads
export function readU8(buf: Uint8Array, offset: number): number {
  return buf[offset] ?? 0;
}
export function readU16LE(buf: Uint8Array, offset: number): number {
  return new BorshReader(buf.slice(offset)).readU16LE();
}
export function readU32LE(buf: Uint8Array, offset: number): number {
  return new BorshReader(buf.slice(offset)).readU32LE();
}
export function readU64LE(buf: Uint8Array, offset: number): bigint {
  return new BorshReader(buf.slice(offset)).readU64LE();
}
export function readI64LE(buf: Uint8Array, offset: number): bigint {
  return new BorshReader(buf.slice(offset)).readI64LE();
}
export function readFixedBytes(buf: Uint8Array, offset: number, n: number): Uint8Array {
  return buf.slice(offset, offset + n);
}
export function readVecU8(buf: Uint8Array, offset: number): { bytes: Uint8Array; nextOffset: number } {
  const len = readU32LE(buf, offset);
  const bytes = buf.slice(offset + 4, offset + 4 + len);
  return { bytes, nextOffset: offset + 4 + len };
}
export function readString(buf: Uint8Array, offset: number): { value: string; nextOffset: number } {
  const { bytes, nextOffset } = readVecU8(buf, offset);
  return { value: new TextDecoder('utf-8').decode(bytes), nextOffset };
}
export function readPublicKey(buf: Uint8Array, offset: number): PublicKey {
  return PublicKey.fromBytes(buf.slice(offset, offset + 32));
}

import { describe, it, expect } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';

import { decodeMint } from './mint';
import { decodeTokenAccount } from './token-account';
import {
  decodeExtensions,
  decodeAccountExtensions,
  ACCOUNT_TYPE_ACCOUNT,
  ACCOUNT_TYPE_MINT,
  ACCOUNT_TYPE_UNINITIALIZED,
  ACCOUNT_TYPE_OFFSET,
  EXTENSION_TYPE,
  TLV_START_OFFSET,
} from './token-2022-extensions';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './program-ids';

// ---------------------------------------------------------------------------
// Byte-level builders — hand-roll extension bytes so tests don't depend on
// any encoder in the main src. This makes the test an independent check
// against the parser, not a mutual tautology.
// ---------------------------------------------------------------------------

function buildBaseMint(): Uint8Array {
  // Bare 82-byte mint: revoked authorities, supply=0, decimals=0, init=1.
  const buf = new Uint8Array(82);
  buf[45] = 0x01; // isInitialized = true
  return buf;
}

function buildBaseAccount(): Uint8Array {
  // Bare 165-byte account: state byte at offset 108 = 1 (initialized).
  const buf = new Uint8Array(165);
  buf[108] = 0x01;
  return buf;
}

/**
 * Stitch a Token-2022 mint or account: base bytes + padding (if mint) +
 * account_type discriminator + TLV bytes.
 */
function stitch(opts: {
  base: Uint8Array;
  accountType: number;
  tlv: Uint8Array;
}): Uint8Array {
  const totalLen = Math.max(ACCOUNT_TYPE_OFFSET, opts.base.length);
  const buf = new Uint8Array(totalLen + 1 + opts.tlv.length);
  buf.set(opts.base, 0);
  // Bytes between base.length..ACCOUNT_TYPE_OFFSET stay zero (that's the
  // mint's padding region — the runtime doesn't care what's in there).
  buf[ACCOUNT_TYPE_OFFSET] = opts.accountType;
  buf.set(opts.tlv, TLV_START_OFFSET);
  return buf;
}

function u16le(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v & 0xffff, true);
  return b;
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function tlv(type: number, data: Uint8Array): Uint8Array {
  return concat([u16le(type), u16le(data.length), data]);
}

const SAMPLE_AUTHORITY = PublicKey.fromBase58(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
const SAMPLE_WITHDRAW = PublicKey.fromBase58(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);
const ZERO_PUBKEY_BYTES = new Uint8Array(32);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decodeExtensions — no TLV region', () => {
  it('returns empty results when data is exactly 82 bytes (bare mint)', () => {
    const result = decodeExtensions(buildBaseMint(), 'mint');
    expect(result.extensions).toEqual({});
    expect(result.unknownExtensions).toEqual([]);
  });

  it('returns empty results when data is exactly 165 bytes (bare account)', () => {
    const result = decodeExtensions(buildBaseAccount(), 'account');
    expect(result.extensions).toEqual({});
    expect(result.unknownExtensions).toEqual([]);
  });

  it('returns empty when account_type discriminator is Uninitialized', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_UNINITIALIZED,
      // Include a TLV entry that would normally decode — should be ignored
      // because the account_type says the data is uninitialized.
      tlv: tlv(EXTENSION_TYPE.MintCloseAuthority, SAMPLE_AUTHORITY.toBuffer()),
    });
    const result = decodeExtensions(data, 'mint');
    expect(result.extensions).toEqual({});
    expect(result.unknownExtensions).toEqual([]);
  });
});

describe('decodeExtensions — MintCloseAuthority', () => {
  it('decodes a set close authority', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.MintCloseAuthority, SAMPLE_AUTHORITY.toBuffer()),
    });
    const result = decodeExtensions(data, 'mint');
    expect(result.extensions.mintCloseAuthority?.closeAuthority?.toBase58()).toBe(
      SAMPLE_AUTHORITY.toBase58(),
    );
    expect(result.unknownExtensions).toEqual([]);
  });

  it('decodes a zero-pubkey close authority as null', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.MintCloseAuthority, ZERO_PUBKEY_BYTES),
    });
    const result = decodeExtensions(data, 'mint');
    expect(result.extensions.mintCloseAuthority).toEqual({
      closeAuthority: null,
    });
  });

  it('throws when the payload is shorter than 32 bytes', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.MintCloseAuthority, new Uint8Array(16)),
    });
    expect(() => decodeExtensions(data, 'mint')).toThrow(
      /MintCloseAuthority payload too short/,
    );
  });
});

describe('decodeExtensions — TransferFeeConfig', () => {
  it('decodes all fields correctly', () => {
    // 108-byte payload:
    //   32 configAuthority
    //   32 withdrawAuthority
    //   8 withheldAmount
    //   18 olderTransferFee (u64 epoch, u64 max, u16 bps)
    //   18 newerTransferFee
    const payload = concat([
      SAMPLE_AUTHORITY.toBuffer(),
      SAMPLE_WITHDRAW.toBuffer(),
      u64le(500n), // withheldAmount
      u64le(100n), // older.epoch
      u64le(1_000n), // older.maximumFee
      u16le(50), // older.transferFeeBasisPoints
      u64le(200n), // newer.epoch
      u64le(2_000n), // newer.maximumFee
      u16le(75), // newer.transferFeeBasisPoints
    ]);

    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.TransferFeeConfig, payload),
    });
    const result = decodeExtensions(data, 'mint');
    const cfg = result.extensions.transferFeeConfig;
    expect(cfg).toBeDefined();
    expect(cfg!.transferFeeConfigAuthority?.toBase58()).toBe(
      SAMPLE_AUTHORITY.toBase58(),
    );
    expect(cfg!.withdrawWithheldAuthority?.toBase58()).toBe(
      SAMPLE_WITHDRAW.toBase58(),
    );
    expect(cfg!.withheldAmount).toBe(500n);
    expect(cfg!.olderTransferFee).toEqual({
      epoch: 100n,
      maximumFee: 1_000n,
      transferFeeBasisPoints: 50,
    });
    expect(cfg!.newerTransferFee).toEqual({
      epoch: 200n,
      maximumFee: 2_000n,
      transferFeeBasisPoints: 75,
    });
  });

  it('surfaces zeroed authorities as null', () => {
    const payload = concat([
      ZERO_PUBKEY_BYTES,
      ZERO_PUBKEY_BYTES,
      u64le(0n),
      u64le(0n),
      u64le(0n),
      u16le(0),
      u64le(0n),
      u64le(0n),
      u16le(0),
    ]);
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.TransferFeeConfig, payload),
    });
    const result = decodeExtensions(data, 'mint');
    const cfg = result.extensions.transferFeeConfig!;
    expect(cfg.transferFeeConfigAuthority).toBeNull();
    expect(cfg.withdrawWithheldAuthority).toBeNull();
  });

  it('throws when the payload is short', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.TransferFeeConfig, new Uint8Array(32)),
    });
    expect(() => decodeExtensions(data, 'mint')).toThrow(
      /TransferFeeConfig payload too short/,
    );
  });
});

describe('decodeExtensions — DefaultAccountState', () => {
  it.each([
    ['uninitialized', 0],
    ['initialized', 1],
    ['frozen', 2],
  ] as const)('maps byte %s → %s', (expected, byte) => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.DefaultAccountState, new Uint8Array([byte])),
    });
    const result = decodeExtensions(data, 'mint');
    expect(result.extensions.defaultAccountState?.state).toBe(expected);
  });

  it('throws on an unknown state byte', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.DefaultAccountState, new Uint8Array([9])),
    });
    expect(() => decodeExtensions(data, 'mint')).toThrow(
      /DefaultAccountState bad state byte 9/,
    );
  });

  it('throws when payload is empty', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.DefaultAccountState, new Uint8Array(0)),
    });
    expect(() => decodeExtensions(data, 'mint')).toThrow(
      /DefaultAccountState payload missing state byte/,
    );
  });
});

describe('decodeExtensions — unknown extensions', () => {
  it('surfaces an unrecognized type in unknownExtensions with its raw data', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(999, payload), // 999 is well outside the known range
    });
    const result = decodeExtensions(data, 'mint');
    expect(result.extensions).toEqual({});
    expect(result.unknownExtensions).toHaveLength(1);
    expect(result.unknownExtensions[0]?.type).toBe(999);
    expect(Array.from(result.unknownExtensions[0]!.data)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('treats account-side known extensions as unknown in T25', () => {
    // ImmutableOwner (type 7) is an account-side extension.
    const data = stitch({
      base: buildBaseAccount(),
      accountType: ACCOUNT_TYPE_ACCOUNT,
      tlv: tlv(EXTENSION_TYPE.ImmutableOwner, new Uint8Array(0)),
    });
    const result = decodeExtensions(data, 'account');
    expect(result.extensions).toEqual({});
    expect(result.unknownExtensions).toHaveLength(1);
    expect(result.unknownExtensions[0]?.type).toBe(
      EXTENSION_TYPE.ImmutableOwner,
    );
  });

  it('parses multiple extensions back-to-back', () => {
    const mcPayload = SAMPLE_AUTHORITY.toBuffer();
    const dasPayload = new Uint8Array([2]);
    const tlvBytes = concat([
      tlv(EXTENSION_TYPE.MintCloseAuthority, mcPayload),
      tlv(EXTENSION_TYPE.DefaultAccountState, dasPayload),
      tlv(42, new Uint8Array([0xde, 0xad])),
    ]);
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlvBytes,
    });
    const result = decodeExtensions(data, 'mint');
    expect(result.extensions.mintCloseAuthority?.closeAuthority?.toBase58()).toBe(
      SAMPLE_AUTHORITY.toBase58(),
    );
    expect(result.extensions.defaultAccountState?.state).toBe('frozen');
    expect(result.unknownExtensions).toHaveLength(1);
    expect(result.unknownExtensions[0]?.type).toBe(42);
  });

  it('stops at an Uninitialized terminator', () => {
    const tlvBytes = concat([
      tlv(EXTENSION_TYPE.MintCloseAuthority, SAMPLE_AUTHORITY.toBuffer()),
      // Uninitialized terminator (type=0, length=0) — parser should stop.
      tlv(EXTENSION_TYPE.Uninitialized, new Uint8Array(0)),
      // These bytes should be ignored:
      tlv(EXTENSION_TYPE.DefaultAccountState, new Uint8Array([1])),
    ]);
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlvBytes,
    });
    const result = decodeExtensions(data, 'mint');
    expect(result.extensions.mintCloseAuthority).toBeDefined();
    expect(result.extensions.defaultAccountState).toBeUndefined();
  });

  it('throws when a TLV entry claims more bytes than remain', () => {
    // Write a header claiming length=100 but only provide 5 bytes of data.
    const header = concat([u16le(99), u16le(100)]);
    const body = new Uint8Array(5);
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: concat([header, body]),
    });
    expect(() => decodeExtensions(data, 'mint')).toThrow(
      /runs past end of buffer/,
    );
  });
});

describe('decodeMint with Token-2022 extensions', () => {
  it('populates extensions when mint has a MintCloseAuthority entry', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.MintCloseAuthority, SAMPLE_AUTHORITY.toBuffer()),
    });
    const mint = decodeMint({ data, owner: TOKEN_2022_PROGRAM_ID });
    expect(mint.tokenProgram).toBe('token-2022');
    expect(
      mint.extensions?.mintCloseAuthority?.closeAuthority?.toBase58(),
    ).toBe(SAMPLE_AUTHORITY.toBase58());
    expect(mint.unknownExtensions).toEqual([]);
  });

  it('leaves extensions undefined for v1 mints even when data contains TLV-shaped trailing bytes', () => {
    // A v1 mint is exactly 82 bytes; pass longer data but with
    // owner=TOKEN_PROGRAM_ID so detection reports spl-v1.
    const data = new Uint8Array(200);
    const base = buildBaseMint();
    data.set(base, 0);
    const mint = decodeMint({ data, owner: TOKEN_PROGRAM_ID });
    expect(mint.tokenProgram).toBe('spl-v1');
    expect(mint.extensions).toBeUndefined();
    expect(mint.unknownExtensions).toBeUndefined();
  });
});

describe('decodeTokenAccount with Token-2022 extensions', () => {
  it('populates unknownExtensions for any account-side TLV entry', () => {
    const data = stitch({
      base: buildBaseAccount(),
      accountType: ACCOUNT_TYPE_ACCOUNT,
      tlv: tlv(EXTENSION_TYPE.ImmutableOwner, new Uint8Array(0)),
    });
    const acc = decodeTokenAccount({ data, owner: TOKEN_2022_PROGRAM_ID });
    expect(acc.tokenProgram).toBe('token-2022');
    expect(acc.extensions).toEqual({});
    expect(acc.unknownExtensions).toHaveLength(1);
    expect(acc.unknownExtensions?.[0]?.type).toBe(
      EXTENSION_TYPE.ImmutableOwner,
    );
  });
});

describe('decodeAccountExtensions', () => {
  it('returns null for non-Token-2022 accounts', () => {
    const data = buildBaseMint();
    const result = decodeAccountExtensions(
      { data, owner: TOKEN_PROGRAM_ID },
      'mint',
    );
    expect(result).toBeNull();
  });

  it('delegates to decodeExtensions for Token-2022 accounts', () => {
    const data = stitch({
      base: buildBaseMint(),
      accountType: ACCOUNT_TYPE_MINT,
      tlv: tlv(EXTENSION_TYPE.MintCloseAuthority, SAMPLE_AUTHORITY.toBuffer()),
    });
    const result = decodeAccountExtensions(
      { data, owner: TOKEN_2022_PROGRAM_ID },
      'mint',
    );
    expect(result).not.toBeNull();
    const mintResult = result as {
      extensions: { mintCloseAuthority?: { closeAuthority: PublicKey | null } };
    };
    expect(
      mintResult.extensions.mintCloseAuthority?.closeAuthority?.toBase58(),
    ).toBe(SAMPLE_AUTHORITY.toBase58());
  });
});

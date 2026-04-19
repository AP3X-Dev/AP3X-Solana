/**
 * `TransactionAssembler` — build v0 (versioned) Solana transaction messages
 * from a list of instructions and sign them with the provided signers.
 *
 * **v0 ONLY.** Legacy `Transaction` is explicitly unsupported per PRP-01
 * conventions — this module emits the versioned wire format exclusively.
 *
 * ---------------------------------------------------------------------------
 * Wire format (the shape this module produces):
 * ---------------------------------------------------------------------------
 *
 *   signed transaction = compactArray<signature[64]> || message
 *
 *   message =
 *     version_byte (0x80)                   // bit 7 set = versioned; low 7 bits = version number
 *     header (3 bytes)
 *       numRequiredSignatures u8            // first N accounts are signers
 *       numReadonlySignedAccounts u8        // of the signers, last M are readonly
 *       numReadonlyUnsignedAccounts u8      // of the non-signers, last K are readonly
 *     staticAccountKeys                     // compactArray<pubkey[32]>
 *     recentBlockhash (32 bytes)            // raw bytes, base58-decoded from the input
 *     instructions                          // compactArray<CompiledInstruction>
 *       programIdIndex u8
 *       accounts compactArray<u8>           // indices into the resolved account list
 *       data compactArray<u8>               // raw instruction data
 *     addressTableLookups                   // compactArray<AddressTableLookup>
 *       accountKey pubkey[32]               // the ALT account's pubkey
 *       writableIndexes compactArray<u8>    // indices into the ALT's address list
 *       readonlyIndexes compactArray<u8>
 *
 * ---------------------------------------------------------------------------
 * Account ordering (critical):
 * ---------------------------------------------------------------------------
 *
 * The resolved account list is split into four contiguous classes, in this
 * exact order:
 *
 *   1. Writable signers   — payer is always first, by spec
 *   2. Readonly signers
 *   3. Writable non-signers
 *   4. Readonly non-signers
 *
 * Only classes (1) + (2) live in the signer prefix — `numRequiredSignatures`
 * is exactly `count(1) + count(2)`. `numReadonlySignedAccounts` is `count(2)`
 * and `numReadonlyUnsignedAccounts` is `count(4)`. The runtime reconstructs
 * the split from those three numbers, so getting them wrong makes the whole
 * message invalid.
 *
 * When the same pubkey appears across multiple instructions with different
 * permissions, we escalate: `isWritable` and `isSigner` are each `OR`ed
 * across all mentions. This mirrors web3.js's
 * `TransactionMessage.compileToV0Message` behaviour.
 *
 * ---------------------------------------------------------------------------
 * Address lookup tables (ALTs):
 * ---------------------------------------------------------------------------
 *
 * ALT-resolvable accounts — non-signer keys that appear in a supplied ALT —
 * DO NOT appear in `staticAccountKeys`. Instead they end up as entries in
 * `addressTableLookups`, and instruction account indices >= numStaticKeys
 * reference them in a specific order:
 *
 *   - All writable ALT keys first (in the order their ALTs were passed;
 *     within each ALT, writable keys appear in `writableIndexes` order).
 *   - All readonly ALT keys next (same rule).
 *
 * Signers NEVER resolve through ALTs — the runtime requires every signer's
 * pubkey in the static list so it can match signatures by position. If a
 * signer pubkey appears in one of the ALTs we quietly ignore the ALT for
 * that key and keep the static slot.
 *
 * Program IDs can resolve through ALTs. The runtime treats them as readonly
 * non-signer accounts for lookup purposes.
 *
 * ---------------------------------------------------------------------------
 * Signing:
 * ---------------------------------------------------------------------------
 *
 * We call `signer.sign(message)` for each signer whose address appears in the
 * signer prefix. The signer order in the input array does NOT determine the
 * output order — signatures are placed at positions matching their address's
 * account index. This means the input `signers: [extraSigner, payer]`
 * produces identical output to `signers: [payer, extraSigner]`.
 *
 * Zero ecosystem deps. Signing is delegated to callers via the `Signer`
 * interface — this module never touches raw secret keys.
 */

import {
  Ap3xError,
  PublicKey,
  base58,
  compactU16,
} from '@ap3x/solana-core';

import type { AddressLookupTable } from './address-lookup-table';

// ---------------------------------------------------------------------------
// TransactionError — thrown when assembly inputs are malformed. Subclasses
// Ap3xError so callers can catch substrate errors uniformly.
// ---------------------------------------------------------------------------

/**
 * Failure modes for {@link assemble}. All are signalled via
 * {@link TransactionError} — callers can catch this class (or the parent
 * {@link Ap3xError}) and read `meta` for structured context.
 */
export type TransactionErrorCode =
  | 'payer_not_in_signers'
  | 'missing_signer'
  | 'invalid_blockhash'
  | 'no_fee_payer'
  | 'bundle_too_large'
  | 'bundle_empty'
  | 'invalid_tip';

/** Structured payload for {@link TransactionError}. */
export interface TransactionErrorMeta {
  /** The account address the failure relates to, when applicable (base58). */
  address?: string;
  /** For `invalid_blockhash`: the actual decoded byte length. */
  actualLength?: number;
  /** For `invalid_blockhash`: the expected decoded byte length. */
  expectedLength?: number;
  /** Additional free-form context. */
  detail?: string;
}

/**
 * Raised when {@link assemble} receives inputs it cannot honour — an unsigned
 * signer, a malformed blockhash, etc. The `code` field is always
 * `tx.<subcode>` so structured log pipelines can branch on it without
 * reading `meta`.
 */
export class TransactionError extends Ap3xError {
  readonly code: `tx.${TransactionErrorCode}`;
  readonly meta: TransactionErrorMeta;

  constructor(
    subCode: TransactionErrorCode,
    message: string,
    meta: TransactionErrorMeta = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = `tx.${subCode}`;
    this.meta = meta;
  }
}

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/** A single account reference inside an instruction. */
export interface AccountMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

/** An instruction the caller wants packaged into the transaction. */
export interface Instruction {
  programId: PublicKey;
  keys: AccountMeta[];
  data: Uint8Array;
}

/**
 * Minimal signer interface — compatible with `WalletHandle` from the vault
 * package (which exposes exactly `address` + `sign` + `signTransaction`). Tests
 * use a bare implementation over `@noble/ed25519`.
 */
export interface Signer {
  /** The signer's public key. */
  readonly address: PublicKey;
  /**
   * Sign the raw message bytes and return the 64-byte ed25519 signature.
   * Implementations MUST sign exactly what they receive — no prefixing,
   * hashing, or wrapping.
   */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * ALT input shape — either a bare decoded ALT (when its accountKey is not
 * needed), or a `{ key, alt }` pair. The wire format requires the ALT's
 * accountKey to appear in each lookup entry, so we accept either shape and
 * extract the key where provided. If a bare {@link AddressLookupTable} is
 * passed, its accountKey defaults to the zero pubkey — callers should
 * normally pass the keyed shape.
 */
export type AssemblerAlt =
  | AddressLookupTable
  | { key: PublicKey; alt: AddressLookupTable };

export interface AssemblerOptions {
  /** Instructions to pack into the transaction, in order. */
  instructions: Instruction[];
  /** Fee-payer public key. Must also appear in `signers`. */
  payer: PublicKey;
  /** Signers for all signer-accounts referenced by `instructions`. */
  signers: Signer[];
  /** Recent blockhash, base58 encoded — must decode to exactly 32 bytes. */
  recentBlockhash: string;
  /** Optional ALTs to compress the account list. */
  alts?: AssemblerAlt[];
}

export interface AssemblerResult {
  /** Wire-ready bytes: signatures + message. Submit this to `sendTransaction`. */
  signedTransaction: Uint8Array;
  /** Just the message bytes (what the signers signed). Useful for inspection. */
  messageBytes: Uint8Array;
  /**
   * The full resolved account list (static keys followed by writable-ALT keys
   * then readonly-ALT keys). Instruction account indices reference this list.
   */
  accountKeys: PublicKey[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Version byte for v0 messages: bit 7 set, low 7 bits = 0. */
const VERSION_V0 = 0x80;

/** Length of a Solana public key in bytes. */
const PUBLIC_KEY_LENGTH = 32;

/** Length of an ed25519 signature in bytes. */
const SIGNATURE_LENGTH = 64;

/** Length of a recent blockhash, in bytes (sha256 digest). */
const BLOCKHASH_LENGTH = 32;

/**
 * Internal account state used while computing the resolved account list.
 * `isSigner` / `isWritable` are OR-reduced across all mentions in the tx.
 * `alt` — if non-null — is the ALT that covers this non-signer key, with
 * `altIndex` being its position inside the ALT's `addresses` list. Signer
 * keys always have `alt: null` (signers never resolve via ALT).
 */
interface AccountInfo {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
  alt: { key: PublicKey; altIndex: number } | null;
}

/** Normalise either input shape into a uniform `{ key, alt }` tuple. */
function normaliseAlt(a: AssemblerAlt): { key: PublicKey; alt: AddressLookupTable } {
  if ('key' in a && 'alt' in a) return a;
  // Bare ALT: synthesise a zero key. Callers almost never want this shape for
  // real transactions (the runtime needs the real ALT account key), but it
  // keeps the test/developer ergonomics simple.
  return { key: PublicKey.fromBytes(new Uint8Array(PUBLIC_KEY_LENGTH)), alt: a };
}

/**
 * Compile the resolved account list from a set of instructions, plus the
 * payer, plus any ALTs. Returns the list in the four-class order described
 * in the file header.
 *
 * The algorithm:
 *   1. Collect every unique pubkey mentioned anywhere (programId or keys),
 *      OR-reducing `isSigner`/`isWritable`. The payer is seeded as
 *      `isSigner=true, isWritable=true` to guarantee it lands at index 0.
 *   2. For every non-signer account, look it up in the supplied ALTs.
 *      First match wins (ALTs in input order, addresses in insertion order).
 *      Signers are never ALT-resolved.
 *   3. Partition into the four classes and concatenate.
 *   4. Static account keys = writable-signers + readonly-signers +
 *      writable-nonsigners (static only, i.e. alt === null) +
 *      readonly-nonsigners (static only).
 *   5. ALT-resolved writable keys and readonly keys are returned alongside
 *      so the caller can emit the `addressTableLookups` region.
 */
function compileAccounts(
  instructions: Instruction[],
  payer: PublicKey,
  alts: { key: PublicKey; alt: AddressLookupTable }[],
): {
  // Static accounts, already in canonical order:
  staticAccounts: AccountInfo[];
  // ALT-resolved accounts by class, each in the order they were discovered:
  altWritable: AccountInfo[];
  altReadonly: AccountInfo[];
  // Quick lookup from pubkey base58 → final account index (across static + ALT).
  indexByBase58: Map<string, number>;
  // Header counts:
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
} {
  // Collect raw account mentions, indexed by base58 pubkey.
  const byKey = new Map<string, AccountInfo>();

  function upsert(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): void {
    const k = pubkey.toBase58();
    const existing = byKey.get(k);
    if (existing) {
      // Escalate permissions (OR-reduce across mentions).
      if (isSigner) existing.isSigner = true;
      if (isWritable) existing.isWritable = true;
      return;
    }
    byKey.set(k, { pubkey, isSigner, isWritable, alt: null });
  }

  // Payer seed — always signer + writable, always wins even if a later
  // instruction mentions it as readonly.
  upsert(payer, true, true);

  for (const ix of instructions) {
    // Program IDs are readonly non-signers — the runtime enforces this.
    upsert(ix.programId, false, false);
    for (const meta of ix.keys) {
      upsert(meta.pubkey, meta.isSigner, meta.isWritable);
    }
  }

  const accounts = Array.from(byKey.values());

  // Attempt ALT resolution for every non-signer. We search ALTs in input
  // order and take the first address match; ties are resolved by the earliest
  // ALT. Signers are skipped (they MUST stay in staticAccountKeys).
  for (const acc of accounts) {
    if (acc.isSigner) continue;
    for (const { key: altKey, alt } of alts) {
      const idx = alt.addresses.findIndex((a) => a.equals(acc.pubkey));
      if (idx >= 0) {
        acc.alt = { key: altKey, altIndex: idx };
        break;
      }
    }
  }

  // Partition into the four classes.
  const writableSigners: AccountInfo[] = [];
  const readonlySigners: AccountInfo[] = [];
  const writableStatic: AccountInfo[] = [];
  const readonlyStatic: AccountInfo[] = [];
  const writableAlt: AccountInfo[] = [];
  const readonlyAlt: AccountInfo[] = [];

  for (const acc of accounts) {
    if (acc.isSigner && acc.isWritable) writableSigners.push(acc);
    else if (acc.isSigner && !acc.isWritable) readonlySigners.push(acc);
    else if (!acc.isSigner && acc.isWritable) {
      if (acc.alt) writableAlt.push(acc);
      else writableStatic.push(acc);
    } else {
      if (acc.alt) readonlyAlt.push(acc);
      else readonlyStatic.push(acc);
    }
  }

  // Enforce payer-first within writable signers.
  const payerB58 = payer.toBase58();
  writableSigners.sort((a, b) => {
    if (a.pubkey.toBase58() === payerB58) return -1;
    if (b.pubkey.toBase58() === payerB58) return 1;
    return 0;
  });

  const staticAccounts = [
    ...writableSigners,
    ...readonlySigners,
    ...writableStatic,
    ...readonlyStatic,
  ];

  // Build the canonical index lookup. Static accounts occupy [0..N-1];
  // then writable-ALT accounts; then readonly-ALT accounts.
  const indexByBase58 = new Map<string, number>();
  let idx = 0;
  for (const acc of staticAccounts) {
    indexByBase58.set(acc.pubkey.toBase58(), idx++);
  }
  for (const acc of writableAlt) {
    indexByBase58.set(acc.pubkey.toBase58(), idx++);
  }
  for (const acc of readonlyAlt) {
    indexByBase58.set(acc.pubkey.toBase58(), idx++);
  }

  return {
    staticAccounts,
    altWritable: writableAlt,
    altReadonly: readonlyAlt,
    indexByBase58,
    numRequiredSignatures: writableSigners.length + readonlySigners.length,
    numReadonlySigned: readonlySigners.length,
    numReadonlyUnsigned: readonlyStatic.length,
  };
}

/**
 * Group ALT-resolved accounts by their source ALT and emit one
 * `addressTableLookup` per ALT that contributes any non-static keys.
 *
 * The writable/readonly split is preserved by keying off the account's own
 * `isWritable` flag rather than which sub-list it came from — this keeps the
 * function correct if the caller shape ever changes.
 */
function buildAddressTableLookups(
  altWritable: AccountInfo[],
  altReadonly: AccountInfo[],
): { accountKey: PublicKey; writableIndexes: number[]; readonlyIndexes: number[] }[] {
  const perAlt = new Map<
    string,
    { accountKey: PublicKey; writableIndexes: number[]; readonlyIndexes: number[] }
  >();

  function lookup(acc: AccountInfo): {
    accountKey: PublicKey;
    writableIndexes: number[];
    readonlyIndexes: number[];
  } {
    // acc.alt is non-null for everything we pass in here.
    const altKey = acc.alt!.key;
    const k = altKey.toBase58();
    let entry = perAlt.get(k);
    if (!entry) {
      entry = { accountKey: altKey, writableIndexes: [], readonlyIndexes: [] };
      perAlt.set(k, entry);
    }
    return entry;
  }

  for (const acc of altWritable) lookup(acc).writableIndexes.push(acc.alt!.altIndex);
  for (const acc of altReadonly) lookup(acc).readonlyIndexes.push(acc.alt!.altIndex);

  return Array.from(perAlt.values());
}

/**
 * Append a compact-u16 length prefix and then `bytes` to the given byte
 * accumulator. Kept as a helper because we emit this pattern a handful of
 * times in the message encoder.
 */
function pushCompactArrayU8(out: number[], bytes: Uint8Array | number[]): void {
  const len = bytes.length;
  for (const b of compactU16.encode(len)) out.push(b);
  for (let i = 0; i < len; i++) out.push(bytes[i]!);
}

/**
 * Serialize the v0 message bytes that signers sign. Order matches the file
 * header comment exactly: version, header, static keys, blockhash,
 * instructions, ALT lookups.
 */
function serializeMessage(
  staticAccounts: AccountInfo[],
  altWritable: AccountInfo[],
  altReadonly: AccountInfo[],
  instructions: Instruction[],
  recentBlockhashBytes: Uint8Array,
  numRequiredSignatures: number,
  numReadonlySigned: number,
  numReadonlyUnsigned: number,
  indexByBase58: Map<string, number>,
): Uint8Array {
  const out: number[] = [];

  // Version byte.
  out.push(VERSION_V0);

  // Header.
  out.push(numRequiredSignatures);
  out.push(numReadonlySigned);
  out.push(numReadonlyUnsigned);

  // Static account keys (compactArray<pubkey>).
  for (const b of compactU16.encode(staticAccounts.length)) out.push(b);
  for (const acc of staticAccounts) {
    const buf = acc.pubkey.toBuffer();
    for (let i = 0; i < PUBLIC_KEY_LENGTH; i++) out.push(buf[i]!);
  }

  // Recent blockhash (32 raw bytes).
  for (let i = 0; i < BLOCKHASH_LENGTH; i++) out.push(recentBlockhashBytes[i]!);

  // Instructions (compactArray<CompiledInstruction>).
  for (const b of compactU16.encode(instructions.length)) out.push(b);
  for (const ix of instructions) {
    const programIdIndex = indexByBase58.get(ix.programId.toBase58());
    if (programIdIndex === undefined) {
      // Should be impossible — compileAccounts always emits program IDs.
      throw new TransactionError(
        'missing_signer',
        `serializeMessage: program id ${ix.programId.toBase58()} not in account list`,
        { address: ix.programId.toBase58() },
      );
    }
    out.push(programIdIndex);

    const accountIndices: number[] = ix.keys.map((meta) => {
      const i = indexByBase58.get(meta.pubkey.toBase58());
      if (i === undefined) {
        throw new TransactionError(
          'missing_signer',
          `serializeMessage: account ${meta.pubkey.toBase58()} not in resolved account list`,
          { address: meta.pubkey.toBase58() },
        );
      }
      return i;
    });
    pushCompactArrayU8(out, accountIndices);

    pushCompactArrayU8(out, ix.data);
  }

  // Address table lookups.
  const lookups = buildAddressTableLookups(altWritable, altReadonly);
  for (const b of compactU16.encode(lookups.length)) out.push(b);
  for (const lk of lookups) {
    const buf = lk.accountKey.toBuffer();
    for (let i = 0; i < PUBLIC_KEY_LENGTH; i++) out.push(buf[i]!);
    pushCompactArrayU8(out, lk.writableIndexes);
    pushCompactArrayU8(out, lk.readonlyIndexes);
  }

  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Assemble and sign a v0 transaction.
 *
 * @throws {@link TransactionError} if the payer is missing from `signers`,
 *         a required signer is missing, or the blockhash is malformed.
 */
export async function assemble(options: AssemblerOptions): Promise<AssemblerResult> {
  const { instructions, payer, signers, recentBlockhash } = options;
  const alts = (options.alts ?? []).map(normaliseAlt);

  // ---- 1. Validate payer ∈ signers ----------------------------------------
  const payerB58 = payer.toBase58();
  const signerByB58 = new Map<string, Signer>();
  for (const s of signers) signerByB58.set(s.address.toBase58(), s);
  if (!signerByB58.has(payerB58)) {
    throw new TransactionError(
      'payer_not_in_signers',
      `assemble: payer ${payerB58} is not present in signers[]`,
      { address: payerB58 },
    );
  }

  // ---- 2. Decode blockhash ------------------------------------------------
  let blockhashBytes: Uint8Array;
  try {
    blockhashBytes = base58.decode(recentBlockhash);
  } catch (err) {
    throw new TransactionError(
      'invalid_blockhash',
      `assemble: recentBlockhash is not valid base58: ${(err as Error).message}`,
      { detail: recentBlockhash },
      { cause: err },
    );
  }
  if (blockhashBytes.length !== BLOCKHASH_LENGTH) {
    throw new TransactionError(
      'invalid_blockhash',
      `assemble: recentBlockhash decodes to ${blockhashBytes.length} bytes, expected ${BLOCKHASH_LENGTH}`,
      {
        actualLength: blockhashBytes.length,
        expectedLength: BLOCKHASH_LENGTH,
      },
    );
  }

  // ---- 3. Compile accounts (ordering, ALT resolution, index lookup) -------
  const compiled = compileAccounts(instructions, payer, alts);

  // ---- 4. Check every signer account has a matching Signer ----------------
  for (const acc of compiled.staticAccounts) {
    if (!acc.isSigner) continue;
    if (!signerByB58.has(acc.pubkey.toBase58())) {
      throw new TransactionError(
        'missing_signer',
        `assemble: signer missing for account ${acc.pubkey.toBase58()}`,
        { address: acc.pubkey.toBase58() },
      );
    }
  }

  // ---- 5. Serialize message bytes -----------------------------------------
  const messageBytes = serializeMessage(
    compiled.staticAccounts,
    compiled.altWritable,
    compiled.altReadonly,
    instructions,
    blockhashBytes,
    compiled.numRequiredSignatures,
    compiled.numReadonlySigned,
    compiled.numReadonlyUnsigned,
    compiled.indexByBase58,
  );

  // ---- 6. Collect signatures in signer-index order ------------------------
  // Iterate the first `numRequiredSignatures` entries of staticAccounts —
  // those are the signer prefix, in canonical order. For each, grab its
  // signer and produce the signature.
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < compiled.numRequiredSignatures; i++) {
    const acc = compiled.staticAccounts[i]!;
    const signer = signerByB58.get(acc.pubkey.toBase58())!;
    const sig = await signer.sign(messageBytes);
    if (sig.length !== SIGNATURE_LENGTH) {
      throw new TransactionError(
        'missing_signer',
        `assemble: signer for ${acc.pubkey.toBase58()} returned ${sig.length}-byte signature, expected ${SIGNATURE_LENGTH}`,
        { address: acc.pubkey.toBase58() },
      );
    }
    signatures.push(sig);
  }

  // ---- 7. Emit the signed transaction (compactArray<sig> + message) -------
  const sigCountPrefix = compactU16.encode(signatures.length);
  const totalLen =
    sigCountPrefix.length + signatures.length * SIGNATURE_LENGTH + messageBytes.length;
  const signedTransaction = new Uint8Array(totalLen);
  signedTransaction.set(sigCountPrefix, 0);
  let off = sigCountPrefix.length;
  for (const sig of signatures) {
    signedTransaction.set(sig, off);
    off += SIGNATURE_LENGTH;
  }
  signedTransaction.set(messageBytes, off);

  return {
    signedTransaction,
    messageBytes,
    accountKeys: [
      ...compiled.staticAccounts.map((a) => a.pubkey),
      ...compiled.altWritable.map((a) => a.pubkey),
      ...compiled.altReadonly.map((a) => a.pubkey),
    ],
  };
}

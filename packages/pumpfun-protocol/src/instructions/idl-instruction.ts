import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import type { AccountMeta, Instruction } from '@ap3x/solana-tx';
import { encodeIdlFields } from '@ap3x/pumpfun-events';
import type { IdlProgramSchema, IdlSeed } from '@ap3x/pumpfun-events';

/**
 * Build an instruction straight from the program's IDL: account order,
 * signer/writable flags, fixed addresses and PDA seeds all come from the
 * schema, so the builders only supply what the chain can't derive.
 *
 * `known` maps IDL account names (snake_case) to addresses. Seeds that read a
 * field out of another account's data (e.g. `bonding_curve.creator`) are
 * looked up under that dotted path, so pass them in `known` too.
 *
 * `remaining` is appended after the IDL accounts. Programs add required
 * accounts this way after an IDL ships (e.g. pump.fun's `bonding-curve-v2`).
 */
export function buildIdlInstruction(
  schema: IdlProgramSchema,
  name: string,
  known: Record<string, PublicKey>,
  args: Record<string, unknown>,
  remaining: AccountMeta[] = [],
): Instruction {
  const ix = schema.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`instruction ${name} not in schema`);
  const programId = PublicKey.fromBase58(schema.address);
  const resolved = new Map<string, PublicKey>(Object.entries(known));

  const seedBytes = (seed: IdlSeed): Uint8Array | undefined => {
    if (seed.kind === 'const') return Uint8Array.from(seed.value);
    if (seed.kind === 'account') return resolved.get(seed.path)?.toBuffer();
    throw new Error(`${name}: arg seeds are not supported`);
  };

  // Seeds can reference accounts listed later (e.g. token_program), so
  // resolve until nothing changes.
  let progress = true;
  while (progress) {
    progress = false;
    for (const a of ix.accounts) {
      if (resolved.has(a.name)) continue;
      let addr: PublicKey | undefined;
      if (a.address) addr = PublicKey.fromBase58(a.address);
      else if (a.name === 'program') addr = programId;
      else if (a.pda) {
        const seeds = a.pda.seeds.map(seedBytes);
        const owner = a.pda.program
          ? a.pda.program.kind === 'const'
            ? PublicKey.fromBytes(Uint8Array.from(a.pda.program.value))
            : a.pda.program.kind === 'account'
              ? resolved.get(a.pda.program.path)
              : undefined
          : programId;
        if (owner && seeds.every((s): s is Uint8Array => s !== undefined)) {
          addr = findProgramAddress(seeds, owner).address;
        }
      }
      if (addr) {
        resolved.set(a.name, addr);
        progress = true;
      }
    }
  }

  const keys: AccountMeta[] = ix.accounts.map((a) => {
    const pubkey = resolved.get(a.name);
    if (!pubkey) throw new Error(`${name}: account ${a.name} must be provided`);
    return { pubkey, isSigner: a.signer, isWritable: a.writable };
  });
  keys.push(...remaining);

  const disc = Uint8Array.from(ix.discriminator.match(/../g)!.map((h) => parseInt(h, 16)));
  const body = encodeIdlFields(ix.args, args, schema.types);
  const data = new Uint8Array(disc.length + body.length);
  data.set(disc, 0);
  data.set(body, disc.length);
  return { programId, keys, data };
}

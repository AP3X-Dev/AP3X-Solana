# @ap3x/solana-tx

Transaction building for the AP3X Solana runtime: PDA derivation, address lookup tables, a v0 transaction assembler, priority-fee tiers, compute budgeting and Jito bundle composition.

## Overview

`@ap3x/solana-tx` builds and signs versioned (v0) transactions only; there is no legacy `Transaction` support. `assemble()` orders accounts into signer and writable classes, compresses the account list with address lookup tables, serialises a v0 message and signs it with the provided signers. Fee tiers come from Geyser-observed landed transactions rather than fixed lamport values.

## Key exports

- `findProgramAddress(seeds, programId)` — returns `{ address, bump }`. Allows at most 16 seeds of at most 32 bytes each.
- **ALTs** — `decodeAlt(account)` returns an `AddressLookupTable`. `findInstructionsForKeys(alts, requiredKeys)` returns an `AltCoverage[]`, ranked by how many required keys each table covers.
- **Assembler** — `assemble({ instructions, payer, signers, recentBlockhash, alts? })` resolves to `{ signedTransaction, messageBytes, accountKeys }`. A `Signer` needs only `address` and `sign(message)`, so a vault `WalletHandle` fits. The assembler throws `TransactionError` (`tx.payer_not_in_signers`, `tx.missing_signer`, `tx.invalid_blockhash`, ...).
- **Priority fees** — `PriorityFeeEstimator({ geyser, windowSlots?, warmupSlots?, onSlot? })` with `start()`, `close()` and `tier(t)`. `tier(t)` returns microlamports per CU for a `FeeTier` (`low`/`med`/`high`/`turbo` map to p50/p75/p90/p99, with turbo raised by a further 10%). Until `warmupSlots` distinct slots (default 30) have been seen, it returns `WARMUP_DEFAULTS`. `quantile` and `SIGNATURE_FEE_LAMPORTS` are also exported.
- **Compute budget** — `simulateAndBudget(rpcPool, txBase64, payer)` runs `simulateTransaction` and returns `{ unitsConsumed, unitsLimit }`, where the limit is consumed units × `BUDGET_HEADROOM` (1.15). It never throws; on any failure it returns `FALLBACK_UNITS_CONSUMED` and `FALLBACK_UNITS_LIMIT`.
- **Jito** — `JitoBundleBuilder`: `compose(txs)` builds a `Bundle` of 1 to `JITO_MAX_TXS_PER_BUNDLE` (5) signed transactions. `tipInstruction(from, tipAccount, lamports)` builds a System Program transfer that pays the tip.
- **Unsigned builds** — `compileUnsigned({ instructions, payer, recentBlockhash, alts? })` compiles the same v0 message `assemble` would sign and returns it with zeroed signature slots (`unsignedTransaction`), plus `messageBytes`, `signers` (slot order, payer first) and `accountKeys`. For services that build a transaction for a wallet to sign.
- **Reading transactions back** — `decodeTransaction(bytes)` → `{ signatures, messageBytes }`; `messageSigners(messageBytes)` lists the required signers (v0 or legacy); `verifyTransactionSignatures(bytes)` is true only with exactly one valid ed25519 signature per required signer. Malformed input throws `tx.malformed`.
- **Compute budget** — `setComputeUnitLimit(units)` (1..`MAX_COMPUTE_UNITS`) and `setComputeUnitPrice(microLamports)`; `COMPUTE_BUDGET_PROGRAM_ID`.
- **System transfers** — `systemTransfer(from, to, lamports)` builds a System Program transfer (`0 < lamports <= u64::MAX`, else `tx.invalid_transfer`). `parseSystemTransfer(ix)` returns `{ from, to, lamports }`, or `null` for anything that is not exactly a well-formed transfer, so callers can check what a transaction pays.

## Usage

```ts
import { JitoBundleBuilder, PriorityFeeEstimator, assemble, decodeAlt, simulateAndBudget } from '@ap3x/solana-tx';

const fees = new PriorityFeeEstimator({ geyser });
fees.start();
const microLamportsPerCu = fees.tier('high');

const { signedTransaction } = await assemble({
  instructions: [computeIx, swapIx],
  payer: wallet.address,
  signers: [wallet],
  recentBlockhash,
  alts: [{ key: altKey, alt: decodeAlt({ data: altData }) }],
});

const budget = await simulateAndBudget(pool, Buffer.from(signedTransaction).toString('base64'), wallet.address);
const bundle = new JitoBundleBuilder().compose([signedTransaction]);
```

## Conventions

- Strategies choose a fee tier and never a lamport amount.
- Pass ALTs as `{ key, alt }`. A bare `AddressLookupTable` gets the zero pubkey as its account key.

## Boundary

`solana-tx` may import from `core` and `connectivity`. `solana-spl` and `solana-metaplex` may import only `findProgramAddress` from this package.

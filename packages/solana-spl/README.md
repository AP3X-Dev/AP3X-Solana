# @ap3x/solana-spl

SPL Token and Token-2022 support for the AP3X Solana runtime: account decoders, associated token accounts, holder queries and transfer decoders.

## Overview

`@ap3x/solana-spl` decodes mint and token accounts for both token programs, including Token-2022 TLV extensions. It derives associated token account (ATA) addresses and builds ATA-create instructions. The layouts are parsed by hand, with no `@solana/spl-token` dependency. Decoders take a structural `AccountInfo` (`{ data, owner? }`). When `owner` is missing, they fall back to classic SPL Token and skip extension parsing.

## Key exports

- **Program IDs** — `TOKEN_PROGRAM_ID`, `TOKEN_2022_PROGRAM_ID`, `ASSOCIATED_TOKEN_PROGRAM_ID`, `SYSTEM_PROGRAM_ID`, and `detectTokenProgram(account)`, which returns `'spl-v1' | 'token-2022'`.
- **Accounts** — `decodeMint(account)` returns a `TokenMint`; `decodeTokenAccount(account)` returns a `TokenAccount`. The helpers `readCOptionPubkey`, `MINT_ACCOUNT_SIZE` (82) and `TOKEN_ACCOUNT_SIZE` (165) are also exported.
- **Token-2022 extensions** — `decodeExtensions(data, kind)`, `decodeAccountExtensions(account, kind)`, `EXTENSION_TYPE` and the layout constants. Mint-side `MintCloseAuthority`, `TransferFeeConfig` and `DefaultAccountState` are decoded into typed fields. Every other extension shows up as an `UnknownExtension` with its type ID.
- **ATA** — `getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve = false, tokenProgramId = TOKEN_PROGRAM_ID)` throws for an off-curve owner unless `allowOwnerOffCurve` is `true`. `createAssociatedTokenAccountIx(payer, owner, mint, tokenProgramId?)` builds a CreateIdempotent instruction, which is safe to retry. `createAssociatedTokenAccountNonIdempotentIx` builds the plain Create instruction.
- **Holder queries** — `getTokenLargestAccounts(rpcPool, mint, commitment?)` and `getTokenAccountsByMint(rpcPool, mint, { commitment?, tokenProgramId? })`. They take an `RpcPoolLike`, meaning any object with a compatible `call`, such as `RpcPool`.
- **Transfer decoders** — `decodeTransferInstruction(ix)` decodes `Transfer` and `TransferChecked` into `DecodedTransfer` (`{ source, dest, amount }`) or returns `null`. `parseTransferLog(chunk)` does the same from a log chunk; this module defines its own structural `ProgramLogChunk` type.

## Usage

```ts
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIx, decodeMint,
  getAssociatedTokenAddress, getTokenLargestAccounts,
} from '@ap3x/solana-spl';

const mintInfo = decodeMint({ data, owner: TOKEN_2022_PROGRAM_ID });
const ata = getAssociatedTokenAddress(mint, wallet, false, TOKEN_2022_PROGRAM_ID);
const createIx = createAssociatedTokenAccountIx(payer, wallet, mint, TOKEN_2022_PROGRAM_ID);
const top = await getTokenLargestAccounts(pool, mint, 'confirmed');
```

## Conventions

- Amounts are raw `bigint` base units with no decimal scaling.
- SPL's `COption` uses a 4-byte tag, unlike Metaplex's 1-byte tag.

## Boundary

`solana-spl` may import from `core` and `tx`. From `tx` it may import only `findProgramAddress`, and it must not import `@ap3x/solana-connectivity` directly: pass the RPC pool in as a parameter. `solana-portfolio` may import only the transfer decoders and `getAssociatedTokenAddress` from this package.

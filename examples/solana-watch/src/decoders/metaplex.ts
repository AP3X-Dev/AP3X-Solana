/**
 * Reference Metaplex Token Metadata decoder for the `solana-watch` example.
 *
 * Mirrors the structure of `./spl.ts` — tags each Metadata program invocation
 * as a `metaplex-metadata-event` and passes through the `Program log:` lines.
 * Instruction-level decoding (CreateMetadataAccountV3, UpdateMetadataAccount,
 * etc.) is out of scope for PRP-01; the `@ap3x/solana-metaplex` package
 * already handles account decoding, which is the substrate's Metaplex
 * responsibility.
 */

import { METADATA_PROGRAM_ID } from '@ap3x/solana-metaplex';
import type { ProgramDecoder, ProgramLogChunk } from '@ap3x/solana-events';

import type { SimpleDecodedEvent } from './spl';

export const metaplexDecoder: ProgramDecoder<SimpleDecodedEvent> = {
  programId: METADATA_PROGRAM_ID,
  decode(chunk: ProgramLogChunk): SimpleDecodedEvent {
    return { kind: 'metaplex-metadata-event', logs: chunk.logs.slice() };
  },
};

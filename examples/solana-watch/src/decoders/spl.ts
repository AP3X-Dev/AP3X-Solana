/**
 * Reference SPL Token + Token-2022 decoders for the `solana-watch` example.
 *
 * These are deliberately shallow: they tag each invocation of the SPL Token
 * program as a `spl-token-event` (or `spl-token-2022-event`) and surface the
 * free-form `Program log:` lines that showed up inside. Real instruction-data
 * decoding (distinguishing `transfer` from `mintTo` from `burn`) is the job
 * of a vertical package — `@ap3x/solana-spl` already owns account decoding,
 * and instruction-level parsing is out of scope for PRP-01.
 *
 * The example's purpose is to demonstrate that the substrate wiring works
 * end-to-end: Geyser → logs → parseLogs → EventDecoderRegistry → JSON line
 * on stdout. A placeholder decoder is fit for that purpose.
 */

import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@ap3x/solana-spl';
import type { ProgramDecoder, ProgramLogChunk } from '@ap3x/solana-events';

/** Shape every decoder in this example emits for a successful decode. */
export interface SimpleDecodedEvent {
  /** Short tag distinguishing the decoder variant. */
  kind: string;
  /** The `Program log:` lines captured inside this invocation, unchanged. */
  logs: string[];
}

export const splTokenDecoder: ProgramDecoder<SimpleDecodedEvent> = {
  programId: TOKEN_PROGRAM_ID,
  decode(chunk: ProgramLogChunk): SimpleDecodedEvent {
    return { kind: 'spl-token-event', logs: chunk.logs.slice() };
  },
};

export const splToken2022Decoder: ProgramDecoder<SimpleDecodedEvent> = {
  programId: TOKEN_2022_PROGRAM_ID,
  decode(chunk: ProgramLogChunk): SimpleDecodedEvent {
    return { kind: 'spl-token-2022-event', logs: chunk.logs.slice() };
  },
};

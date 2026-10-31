import { createRequire } from 'node:module';
import type sodiumApi from 'libsodium-wrappers-sumo';

// The 0.7.x sumo wrapper's ESM entry references a file it does not ship.
// A workspace dependency patch cannot repair an npm consumer's installation.
// Select the upstream public CommonJS export in both module formats, retaining
// the sumo build (including Argon2id) and the existing cryptographic wire format.
const requireSodium = createRequire(typeof import.meta.url === 'string' ? import.meta.url : __filename);
const sodium = requireSodium('libsodium-wrappers-sumo') as typeof sodiumApi;
export default sodium;

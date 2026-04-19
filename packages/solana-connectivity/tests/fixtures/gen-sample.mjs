// Generate geyser-stream-sample.bin from the vendored proto.
// Run from the package root with: node tests/fixtures/gen-sample.mjs
//
// Produces a length-prefixed sequence of SubscribeUpdate messages matching
// the synthetic stream the unit tests use. Reproducible — no network calls.

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
// protobufjs ships as a transitive dep of @grpc/proto-loader. Resolve it
// through the loader's dependency tree so the fixture generator doesn't
// need its own protobufjs dev-dep.
const loaderPath = req.resolve('@grpc/proto-loader');
const loaderRequire = createRequire(loaderPath);
const protobuf = loaderRequire('protobufjs');

const here = dirname(fileURLToPath(import.meta.url));
const protoDir = resolve(here, '..', '..', 'src', 'proto');
const protoPath = resolve(protoDir, 'yellowstone.proto');

// Load the proto files directly with protobufjs so we can reach the
// `.lookupType` / `.encode` methods. @grpc/proto-loader would give us an
// already-processed service definition but strips the reflection handles
// we need to encode arbitrary messages by fully qualified name.
const root = await protobuf.load([
  protoPath,
  resolve(protoDir, 'solana-storage.proto'),
]);
const SubscribeUpdate = root.lookupType('geyser.SubscribeUpdate');

// protobufjs verify() accepts integers or Long-like objects for u64 fields
// — strings don't pass verify() even though @grpc/proto-loader's runtime
// path accepts them. Pass numbers here; the on-wire encoding is the same.
const messages = [
  { slot: { slot: 100, status: 0 } },
  { slot: { slot: 101, status: 0 } },
  { slot: { slot: 105, status: 0 } },
  { ping: {} },
];

const encoded = messages.map((m) => {
  const verified = SubscribeUpdate.verify(m);
  if (verified) throw new Error(`invalid sample message: ${verified}`);
  return SubscribeUpdate.encode(SubscribeUpdate.create(m)).finish();
});

const totalLen = encoded.reduce((s, b) => s + 4 + b.length, 0);
const out = new Uint8Array(totalLen);
const view = new DataView(out.buffer);
let off = 0;
for (const b of encoded) {
  view.setUint32(off, b.length, true);
  off += 4;
  out.set(b, off);
  off += b.length;
}

const dest = resolve(here, 'geyser-stream-sample.bin');
writeFileSync(dest, out);
console.log(`wrote ${out.length} bytes to ${dest}`);

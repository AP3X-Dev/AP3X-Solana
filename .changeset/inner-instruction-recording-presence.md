---
"@ap3x/solana-connectivity": minor
---

Preserve inner instruction recording evidence in full streamed transactions.
Expose optional innerInstructionsRecorded: supplied arrays, including empty
arrays, are recorded; explicit null is not recorded; absent or unsupported
metadata stays unknown. Retain the compatibility instruction array without
using an empty default as proof that recording occurred.

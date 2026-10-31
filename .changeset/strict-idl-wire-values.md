---
"@ap3x/pumpfun-events": patch
---

Reject out-of-range or inexact integers, implicit boolean/string/byte coercions, incorrect fixed-array/tuple lengths and enum ordinals that cannot fit the wire format. Preserve exact supported integer values instead of silently wrapping them. Decode only canonical bool/option tags and valid UTF-8 strings. Valid existing IDL values and field-boundary layout compatibility remain supported.

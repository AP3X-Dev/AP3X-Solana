---
"@ap3x/solana-spl": minor
---

Expose exact transfer instruction details, including checked mint/decimals, authority, multisig accounts and the Token-2022 TransferCheckedWithFee expected fee. Preserve the existing transfer decoder's output shape and supported variants. Instruction semantics do not establish owners, actual withholding or successful execution.

/**
 * Parse `--wallet <base58>` flags from CLI argv. Supports both space-separated
 * (`--wallet ABC`) and equals-separated (`--wallet=ABC`) forms. Returns the
 * unique set; empty set if none specified.
 *
 * Validation: each value must be 32-44 character base58 (matches Solana
 * pubkey base58 length range — System Program is 32 chars, most pubkeys 43-44).
 * Invalid values throw.
 */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseWalletFlags(argv: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (arg === '--wallet' && i + 1 < argv.length) {
      value = argv[i + 1];
      i++;
    } else if (arg.startsWith('--wallet=')) {
      value = arg.slice('--wallet='.length);
    }
    if (value !== undefined) {
      if (!BASE58_RE.test(value)) {
        throw new Error(`invalid --wallet value (must be 32-44 char base58): ${value}`);
      }
      out.add(value);
    }
  }
  return out;
}

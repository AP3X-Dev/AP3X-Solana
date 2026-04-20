import { describe, it, expect } from 'vitest';
import { parseWalletFlags } from './wallets.js';

// A valid 44-char Solana pubkey base58 string.
const WALLET_A = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// Another valid pubkey (32-char minimum — System Program).
const WALLET_B = '11111111111111111111111111111111';
// A third valid pubkey for dedup test.
const WALLET_C = '11111111111111111111111111111112';

describe('parseWalletFlags', () => {
  it('returns empty set when no --wallet flags present', () => {
    expect(parseWalletFlags([])).toEqual(new Set());
    expect(parseWalletFlags(['--rpc', 'https://api.mainnet-beta.solana.com'])).toEqual(new Set());
  });

  it('parses a single space-separated --wallet flag', () => {
    const result = parseWalletFlags(['--wallet', WALLET_A]);
    expect(result).toEqual(new Set([WALLET_A]));
  });

  it('parses multiple separate --wallet flags', () => {
    const result = parseWalletFlags([
      '--wallet', WALLET_A,
      '--wallet', WALLET_B,
    ]);
    expect(result).toEqual(new Set([WALLET_A, WALLET_B]));
  });

  it('deduplicates repeated identical wallet values', () => {
    const result = parseWalletFlags([
      '--wallet', WALLET_A,
      '--wallet', WALLET_A,
    ]);
    expect(result.size).toBe(1);
    expect(result.has(WALLET_A)).toBe(true);
  });

  it('parses equals-form --wallet=<value>', () => {
    const result = parseWalletFlags([`--wallet=${WALLET_A}`]);
    expect(result).toEqual(new Set([WALLET_A]));
  });

  it('accepts a mix of space-separated and equals-form flags', () => {
    const result = parseWalletFlags([
      '--wallet', WALLET_A,
      `--wallet=${WALLET_B}`,
    ]);
    expect(result).toEqual(new Set([WALLET_A, WALLET_B]));
  });

  it('throws on an invalid base58 value', () => {
    expect(() => parseWalletFlags(['--wallet', 'not-valid!'])).toThrowError(
      /invalid --wallet value/,
    );
  });

  it('ignores other CLI args interspersed with --wallet', () => {
    const result = parseWalletFlags([
      '--fixture', '/path/to/fixture.jsonl.gz',
      '--wallet', WALLET_A,
      '--rpc', 'https://api.mainnet-beta.solana.com',
      '--wallet', WALLET_C,
    ]);
    expect(result).toEqual(new Set([WALLET_A, WALLET_C]));
  });

  it('handles --wallet at end of argv with no value gracefully (no crash)', () => {
    // No next token — should be silently ignored.
    const result = parseWalletFlags(['--wallet']);
    expect(result).toEqual(new Set());
  });
});

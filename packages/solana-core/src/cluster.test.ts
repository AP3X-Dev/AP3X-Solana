import { describe, it, expect } from 'vitest';
import { Cluster, clusterRpcUrl } from './cluster';

describe('Cluster', () => {
  it('exposes the four canonical members', () => {
    expect(Cluster.Mainnet).toBe('mainnet');
    expect(Cluster.Devnet).toBe('devnet');
    expect(Cluster.Testnet).toBe('testnet');
    expect(Cluster.Custom).toBe('custom');
  });
});

describe('clusterRpcUrl', () => {
  it('returns the public mainnet-beta endpoint for Mainnet', () => {
    expect(clusterRpcUrl(Cluster.Mainnet)).toBe(
      'https://api.mainnet-beta.solana.com',
    );
  });

  it('returns the public devnet endpoint for Devnet', () => {
    expect(clusterRpcUrl(Cluster.Devnet)).toBe('https://api.devnet.solana.com');
  });

  it('returns the public testnet endpoint for Testnet', () => {
    expect(clusterRpcUrl(Cluster.Testnet)).toBe(
      'https://api.testnet.solana.com',
    );
  });

  it('returns the provided customUrl for Cluster.Custom', () => {
    expect(
      clusterRpcUrl(Cluster.Custom, 'https://rpc.example.com'),
    ).toBe('https://rpc.example.com');
  });

  it('throws when Cluster.Custom is used without a customUrl', () => {
    expect(() => clusterRpcUrl(Cluster.Custom)).toThrow(/customUrl/i);
  });

  it('throws when Cluster.Custom is used with an empty customUrl', () => {
    // Empty string is semantically "missing"; guard it explicitly.
    expect(() => clusterRpcUrl(Cluster.Custom, '')).toThrow(/customUrl/i);
  });

  it('ignores customUrl for non-Custom clusters', () => {
    // Passing a customUrl alongside a named cluster must not override the
    // default — named clusters have canonical endpoints.
    expect(
      clusterRpcUrl(Cluster.Mainnet, 'https://rpc.example.com'),
    ).toBe('https://api.mainnet-beta.solana.com');
  });
});

/**
 * Cluster identifiers and default RPC endpoint resolution.
 *
 * Per spec Section 3.1 this is a tiny standalone helper that names the three
 * public Solana clusters and allows a caller-supplied custom endpoint. The
 * named-cluster URLs are the ones documented at
 * {@link https://solana.com/docs/core/clusters}.
 *
 * Zero runtime deps. Lives in `@ap3x/solana-core` so every other substrate
 * package can import it without a cycle.
 */

/**
 * Solana cluster selector. The enum uses string values so it survives type
 * erasure cleanly — useful for logs, config files, and structured error
 * messages without needing a reverse-lookup.
 */
export enum Cluster {
  Mainnet = 'mainnet',
  Devnet = 'devnet',
  Testnet = 'testnet',
  Custom = 'custom',
}

/** Canonical endpoints for the three public Solana clusters. */
const DEFAULT_ENDPOINTS: Readonly<Record<Exclude<Cluster, Cluster.Custom>, string>> = {
  [Cluster.Mainnet]: 'https://api.mainnet-beta.solana.com',
  [Cluster.Devnet]: 'https://api.devnet.solana.com',
  [Cluster.Testnet]: 'https://api.testnet.solana.com',
};

/**
 * Resolve the RPC URL for a cluster.
 *
 * For named clusters ({@link Cluster.Mainnet}, {@link Cluster.Devnet},
 * {@link Cluster.Testnet}) this returns the canonical public endpoint; any
 * `customUrl` is ignored because the named clusters have fixed identities.
 *
 * For {@link Cluster.Custom} the caller must supply a non-empty `customUrl`,
 * otherwise this throws. A future task (T7) will upgrade the thrown type to
 * `ConfigError` — for now a plain `Error` is used to keep the task dependency
 * graph flat.
 *
 * @param cluster    cluster selector
 * @param customUrl  RPC URL — required iff `cluster === Cluster.Custom`
 * @returns          HTTPS RPC endpoint URL
 */
export function clusterRpcUrl(cluster: Cluster, customUrl?: string): string {
  if (cluster === Cluster.Custom) {
    if (customUrl === undefined || customUrl === '') {
      throw new Error('clusterRpcUrl: customUrl required for Cluster.Custom');
    }
    return customUrl;
  }
  return DEFAULT_ENDPOINTS[cluster];
}

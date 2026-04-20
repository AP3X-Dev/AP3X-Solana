/**
 * Read-side surfaces a strategy interacts with at runtime — portfolio, vault,
 * state, metrics, pricing, and logging. Constructed by the runtime (T42) and
 * threaded into every hook call.
 */
import type { PublicKey } from '@ap3x/solana-core';
import type { PortfolioReadApi } from '@ap3x/solana-portfolio';

export interface VaultReadApi {
  getAddress(name: string): Promise<PublicKey>;
  list(): Promise<Array<{ name: string; role: string; address: PublicKey }>>;
}

export interface PriceSource {
  getPriceLamportsPerToken(mint: PublicKey, atSlot?: number): Promise<bigint | null>;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(err: unknown, meta?: Record<string, unknown>): void;
}

export interface MetricsEmitter {
  emit(topic: string, payload: Record<string, unknown>): void;
}

export interface StrategyStateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface StrategyContext {
  readonly portfolio: PortfolioReadApi;
  readonly vault: VaultReadApi;
  readonly state: StrategyStateStore;
  readonly metrics: MetricsEmitter;
  readonly priceSource?: PriceSource;
  readonly logger: Logger;
  now(): number;
}

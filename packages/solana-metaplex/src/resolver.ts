/**
 * `MetadataResolver` — fetches + caches off-chain Metaplex metadata JSON.
 *
 * On-chain Metaplex metadata stores only a URI pointer to the actual
 * metadata document (name, image, attributes, …). Resolving that URI is a
 * separate concern from the on-chain decoder, so it lives in its own module
 * with its own caching + validation story.
 *
 * Key behaviours (all explicit in the public surface):
 *
 *   1. **Tolerant by design.** Malformed JSON, missing `name`, or bad
 *      `attributes` shape produce a `parseErrors` entry — never a thrown
 *      exception. Agents should degrade gracefully when off-chain metadata
 *      is broken; they should NOT fall over. The only case we re-throw is
 *      a total fetch failure (network, timeout). Document precisely — see
 *      {@link MetadataResolver.resolve}.
 *
 *   2. **Three cache layers.** Memory LRU → on-disk file cache → network.
 *      The `source` field on the result records which layer satisfied the
 *      request, which lets callers reason about freshness and audit cache
 *      behaviour in tests.
 *
 *   3. **Hand-rolled validation.** No Zod, no Ajv. The JSON schema for
 *      off-chain metadata is laughably simple and using a schema library
 *      would just add a dep. We walk the parsed object and surface
 *      individual issues as strings.
 *
 * Zero ecosystem-SDK deps: only `@ap3x/solana-core` (for `HttpClient`) +
 * the Node standard library.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HttpClient } from '@ap3x/solana-core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-attribute trait shape as commonly seen in Metaplex metadata JSON. */
export interface MetadataAttribute {
  /** Trait category name. */
  trait_type: string;
  /** Trait value. Often a string or number but we pass through anything. */
  value: unknown;
}

/** Shape we attempt to extract from resolved metadata documents. */
export interface ParsedMetadata {
  /** Display name. Required (absence is surfaced in `parseErrors`). */
  name: string;
  /** Short ticker / symbol, if present. */
  symbol?: string;
  /** Human-readable description. */
  description?: string;
  /** Image URL/URI — IPFS, HTTPS, or data URI. */
  image?: string;
  /** Trait list. Malformed entries are dropped with an entry in `parseErrors`. */
  attributes?: MetadataAttribute[];
}

/** Fetch-layer identifier — which cache tier served the result. */
export type MetadataSource = 'network' | 'memoryCache' | 'fileCache';

/**
 * Outcome of resolving a URI. Always returned — even on malformed content.
 * Only a total fetch failure (network error, timeout) throws.
 */
export interface ResolvedMetadata {
  /** Parsed JSON if the body parsed, otherwise the raw text. */
  raw: unknown;
  /** Best-effort extraction of the known fields. Present iff JSON parsed. */
  parsed?: ParsedMetadata;
  /** Non-fatal validation issues discovered during extraction. */
  parseErrors?: string[];
  /** Which cache tier served the result. */
  source: MetadataSource;
  /** ISO-8601 timestamp the value was obtained (network) or first cached. */
  fetchedAt: string;
}

/** Constructor options for {@link MetadataResolver}. */
export interface MetadataResolverOptions {
  /**
   * HTTP client used for network fetches. A default is constructed with
   * `timeoutMs: 10000` (or your override) when omitted.
   */
  httpClient?: HttpClient;
  /** Max entries kept in the in-memory LRU. Defaults to 1000. */
  cacheSize?: number;
  /**
   * Optional directory for on-disk cache. When set, resolved entries are
   * persisted as `<dir>/<sha256-of-uri>.json`, and the dir is consulted
   * before the network on future lookups. Absent = no file cache.
   */
  fileCacheDir?: string;
  /** Per-fetch timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
}

/** Default timeout if the caller supplies neither `httpClient` nor `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default LRU capacity. */
const DEFAULT_CACHE_SIZE = 1000;

// ---------------------------------------------------------------------------
// On-disk cache record shape
// ---------------------------------------------------------------------------

interface FileCacheRecord {
  raw: unknown;
  parsed?: ParsedMetadata;
  parseErrors?: string[];
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// MetadataResolver
// ---------------------------------------------------------------------------

export class MetadataResolver {
  readonly #http: HttpClient;
  readonly #cap: number;
  readonly #fileCacheDir: string | undefined;
  readonly #timeoutMs: number;

  /**
   * In-memory LRU. A plain `Map` preserves insertion order; we achieve
   * "most-recently-used = last" by deleting + re-setting on read. Eviction
   * drops the oldest key (first in iteration order) when size exceeds cap.
   */
  readonly #memoryCache = new Map<string, ResolvedMetadata>();

  constructor(options: MetadataResolverOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#http =
      options.httpClient ?? new HttpClient({ timeoutMs: this.#timeoutMs });
    this.#cap = options.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.#fileCacheDir = options.fileCacheDir;
    if (this.#fileCacheDir !== undefined && !existsSync(this.#fileCacheDir)) {
      mkdirSync(this.#fileCacheDir, { recursive: true });
    }
  }

  /**
   * Resolve a metadata URI. Consults memory → file → network in order.
   *
   * @throws RpcError / TimeoutError on a total network failure (never on
   *         malformed JSON / bad shape — those become {@link parseErrors}).
   */
  async resolve(uri: string): Promise<ResolvedMetadata> {
    // 1. Memory cache hit — move to MRU slot by re-inserting.
    const memHit = this.#memoryCache.get(uri);
    if (memHit) {
      this.#memoryCache.delete(uri);
      this.#memoryCache.set(uri, memHit);
      return { ...memHit, source: 'memoryCache' };
    }

    // 2. On-disk cache hit — promote into memory + return tagged fileCache.
    const fileHit = this.#readFromFileCache(uri);
    if (fileHit) {
      this.#putInMemory(uri, fileHit);
      return { ...fileHit, source: 'fileCache' };
    }

    // 3. Network fetch.
    const response = await this.#http.get(uri);
    const text = await response.text();
    const result = this.#buildResult(text);
    // Persist to caches BEFORE returning — keeps source='network' for the
    // current caller while making the next call satisfy from memory/file.
    this.#putInMemory(uri, result);
    this.#writeToFileCache(uri, result);
    return result;
  }

  /** Drop every entry from the in-memory LRU. Does not touch the file cache. */
  clearCache(): void {
    this.#memoryCache.clear();
  }

  // -------------------------------------------------------------------------
  // Result construction
  // -------------------------------------------------------------------------

  #buildResult(text: string): ResolvedMetadata {
    const fetchedAt = new Date().toISOString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        raw: text,
        parseErrors: [`invalid JSON: ${msg}`],
        source: 'network',
        fetchedAt,
      };
    }

    const { parsed: extracted, errors } = extractShape(parsed);
    const out: ResolvedMetadata = {
      raw: parsed,
      source: 'network',
      fetchedAt,
    };
    if (extracted) out.parsed = extracted;
    if (errors.length > 0) out.parseErrors = errors;
    return out;
  }

  // -------------------------------------------------------------------------
  // Memory LRU
  // -------------------------------------------------------------------------

  #putInMemory(uri: string, value: ResolvedMetadata): void {
    // Delete first (no-op if absent) so the re-set lands at MRU position.
    this.#memoryCache.delete(uri);
    this.#memoryCache.set(uri, value);
    // Evict oldest entries until we're back at cap.
    while (this.#memoryCache.size > this.#cap) {
      const oldest = this.#memoryCache.keys().next().value;
      if (oldest === undefined) break;
      this.#memoryCache.delete(oldest);
    }
  }

  // -------------------------------------------------------------------------
  // File cache
  // -------------------------------------------------------------------------

  #fileCachePath(uri: string): string | undefined {
    if (this.#fileCacheDir === undefined) return undefined;
    const hash = createHash('sha256').update(uri).digest('hex');
    return join(this.#fileCacheDir, `${hash}.json`);
  }

  #readFromFileCache(uri: string): ResolvedMetadata | undefined {
    const path = this.#fileCachePath(uri);
    if (!path || !existsSync(path)) return undefined;
    try {
      const text = readFileSync(path, 'utf8');
      const record = JSON.parse(text) as FileCacheRecord;
      const out: ResolvedMetadata = {
        raw: record.raw,
        source: 'fileCache',
        fetchedAt: record.fetchedAt,
      };
      if (record.parsed) out.parsed = record.parsed;
      if (record.parseErrors) out.parseErrors = record.parseErrors;
      return out;
    } catch {
      // A corrupt file is no worse than a cache miss — silently fall
      // through to the network path.
      return undefined;
    }
  }

  #writeToFileCache(uri: string, value: ResolvedMetadata): void {
    const path = this.#fileCachePath(uri);
    if (!path) return;
    const record: FileCacheRecord = {
      raw: value.raw,
      fetchedAt: value.fetchedAt,
    };
    if (value.parsed) record.parsed = value.parsed;
    if (value.parseErrors) record.parseErrors = value.parseErrors;
    try {
      writeFileSync(path, JSON.stringify(record));
    } catch {
      // Best-effort — a writable file cache is an optimisation, not a
      // correctness requirement. Swallow errors rather than bubble them
      // up to the caller, who just wanted metadata.
    }
  }
}

// ---------------------------------------------------------------------------
// Shape extraction — kept as a pure free function for easy testing
// ---------------------------------------------------------------------------

/**
 * Walk a parsed JSON value and pull out the fields we care about.
 *
 * Returns `parsed = undefined` if the top-level value is not an object at
 * all (e.g. a bare string or number). Missing or malformed individual
 * fields are surfaced as `errors` entries; other fields are still
 * populated so callers always see as much as we could rescue.
 *
 * Exported so tests can drive it directly without spinning up an HTTP
 * mock — it's the interesting logic in the resolver.
 */
export function extractShape(
  value: unknown,
): { parsed?: ParsedMetadata; errors: string[] } {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('root is not a JSON object');
    return { errors };
  }
  const obj = value as Record<string, unknown>;
  const out: Partial<ParsedMetadata> = {};

  // name — required
  if (typeof obj.name === 'string') {
    out.name = obj.name;
  } else {
    errors.push('missing name');
  }

  // symbol — optional string
  if (obj.symbol !== undefined) {
    if (typeof obj.symbol === 'string') out.symbol = obj.symbol;
    else errors.push('symbol must be a string');
  }

  // description — optional string
  if (obj.description !== undefined) {
    if (typeof obj.description === 'string') out.description = obj.description;
    else errors.push('description must be a string');
  }

  // image — optional string
  if (obj.image !== undefined) {
    if (typeof obj.image === 'string') out.image = obj.image;
    else errors.push('image must be a string');
  }

  // attributes — optional array of { trait_type, value }
  if (obj.attributes !== undefined) {
    if (!Array.isArray(obj.attributes)) {
      errors.push('attributes must be an array');
    } else {
      const kept: MetadataAttribute[] = [];
      for (let i = 0; i < obj.attributes.length; i++) {
        const entry = obj.attributes[i];
        if (
          entry === null ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          typeof (entry as { trait_type?: unknown }).trait_type !== 'string'
        ) {
          errors.push(`attributes[${i}] malformed`);
          continue;
        }
        const e = entry as { trait_type: string; value: unknown };
        kept.push({ trait_type: e.trait_type, value: e.value });
      }
      if (kept.length > 0) out.attributes = kept;
    }
  }

  // Only produce a `parsed` object if we have at least `name` — without
  // it the shape is meaningless for downstream consumers. Still emit
  // parseErrors in that case so the caller knows why.
  if (out.name === undefined) {
    return { errors };
  }
  return { parsed: out as ParsedMetadata, errors };
}

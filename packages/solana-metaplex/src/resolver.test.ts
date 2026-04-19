import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpClient } from '@ap3x/solana-core';

import {
  MetadataResolver,
  extractShape,
  type ResolvedMetadata,
} from './resolver';

// ---------------------------------------------------------------------------
// msw bootstrap
// ---------------------------------------------------------------------------

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Deterministic HttpClient — zero retries, generous timeout. We swap in
// the default to keep the tests focused on the resolver's behaviour, not
// retry politics.
function makeHttp(): HttpClient {
  return new HttpClient({ timeoutMs: 1000 });
}

// ---------------------------------------------------------------------------
// Happy + degraded fetch paths
// ---------------------------------------------------------------------------

describe('MetadataResolver.resolve — fetch paths', () => {
  it('returns parsed metadata with no parseErrors for a well-formed JSON body', async () => {
    const body = {
      name: 'My NFT',
      symbol: 'MYNFT',
      description: 'Test',
      image: 'https://example.com/img.png',
      attributes: [
        { trait_type: 'color', value: 'red' },
        { trait_type: 'level', value: 7 },
      ],
    };
    server.use(
      http.get('http://meta.test/ok.json', () => HttpResponse.json(body)),
    );
    const r = new MetadataResolver({ httpClient: makeHttp() });
    const res = await r.resolve('http://meta.test/ok.json');

    expect(res.source).toBe('network');
    expect(res.parseErrors).toBeUndefined();
    expect(res.parsed).toBeDefined();
    expect(res.parsed!.name).toBe('My NFT');
    expect(res.parsed!.symbol).toBe('MYNFT');
    expect(res.parsed!.image).toBe('https://example.com/img.png');
    expect(res.parsed!.attributes).toHaveLength(2);
    // fetchedAt is an ISO-8601 string
    expect(() => new Date(res.fetchedAt).toISOString()).not.toThrow();
  });

  it('keeps malformed JSON intact in `raw` with a parseErrors entry', async () => {
    server.use(
      http.get(
        'http://meta.test/broken.json',
        () => new HttpResponse('{not json', { status: 200 }),
      ),
    );
    const r = new MetadataResolver({ httpClient: makeHttp() });
    const res = await r.resolve('http://meta.test/broken.json');

    expect(res.source).toBe('network');
    expect(res.parsed).toBeUndefined();
    expect(res.raw).toBe('{not json');
    expect(res.parseErrors).toBeDefined();
    expect(res.parseErrors![0]).toMatch(/invalid JSON/);
  });

  it('surfaces `missing name` when JSON parses but has no name', async () => {
    server.use(
      http.get('http://meta.test/no-name.json', () =>
        HttpResponse.json({ symbol: 'X' }),
      ),
    );
    const r = new MetadataResolver({ httpClient: makeHttp() });
    const res = await r.resolve('http://meta.test/no-name.json');

    expect(res.source).toBe('network');
    expect(res.parsed).toBeUndefined();
    expect(res.parseErrors).toContain('missing name');
  });

  it('keeps other fields when `attributes` is malformed', async () => {
    server.use(
      http.get('http://meta.test/bad-attrs.json', () =>
        HttpResponse.json({
          name: 'Has Bad Attrs',
          image: 'ipfs://xyz',
          attributes: 'not-an-array',
        }),
      ),
    );
    const r = new MetadataResolver({ httpClient: makeHttp() });
    const res = await r.resolve('http://meta.test/bad-attrs.json');

    expect(res.parsed).toBeDefined();
    expect(res.parsed!.name).toBe('Has Bad Attrs');
    expect(res.parsed!.image).toBe('ipfs://xyz');
    expect(res.parsed!.attributes).toBeUndefined();
    expect(res.parseErrors).toContain('attributes must be an array');
  });

  it('drops individual malformed attribute entries but keeps good ones', async () => {
    server.use(
      http.get('http://meta.test/some-bad-attrs.json', () =>
        HttpResponse.json({
          name: 'Mixed',
          attributes: [
            { trait_type: 'good', value: 1 },
            null,
            { value: 'no-trait-type' },
            { trait_type: 'also good', value: 'yes' },
          ],
        }),
      ),
    );
    const r = new MetadataResolver({ httpClient: makeHttp() });
    const res = await r.resolve('http://meta.test/some-bad-attrs.json');

    expect(res.parsed!.attributes).toHaveLength(2);
    expect(res.parsed!.attributes![0]!.trait_type).toBe('good');
    expect(res.parsed!.attributes![1]!.trait_type).toBe('also good');
    expect(res.parseErrors?.filter((e) => e.includes('attributes['))).toHaveLength(2);
  });

  it('rejects a non-object JSON root (e.g. a bare string)', async () => {
    server.use(
      http.get('http://meta.test/bare.json', () =>
        HttpResponse.json('just a string'),
      ),
    );
    const r = new MetadataResolver({ httpClient: makeHttp() });
    const res = await r.resolve('http://meta.test/bare.json');

    expect(res.parsed).toBeUndefined();
    expect(res.parseErrors).toContain('root is not a JSON object');
    expect(res.raw).toBe('just a string');
  });

  it('throws on total fetch failure (propagates HttpClient error)', async () => {
    server.use(
      http.get('http://meta.test/fail.json', () => HttpResponse.error()),
    );
    const r = new MetadataResolver({ httpClient: makeHttp() });
    await expect(r.resolve('http://meta.test/fail.json')).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Caching — memory LRU + file cache
// ---------------------------------------------------------------------------

describe('MetadataResolver caching', () => {
  it('second resolve of the same URI skips the network (memoryCache source)', async () => {
    let hits = 0;
    server.use(
      http.get('http://meta.test/cache.json', () => {
        hits += 1;
        return HttpResponse.json({ name: 'Cached' });
      }),
    );
    const r = new MetadataResolver({ httpClient: makeHttp() });
    const first = await r.resolve('http://meta.test/cache.json');
    const second = await r.resolve('http://meta.test/cache.json');

    expect(first.source).toBe('network');
    expect(second.source).toBe('memoryCache');
    expect(hits).toBe(1);
    // Same parsed content, independent of source.
    expect(second.parsed!.name).toBe('Cached');
  });

  it('loads from disk cache when a fresh resolver points at the same dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metaplex-file-cache-'));
    try {
      server.use(
        http.get('http://meta.test/persisted.json', () =>
          HttpResponse.json({ name: 'Persisted' }),
        ),
      );
      const r1 = new MetadataResolver({
        httpClient: makeHttp(),
        fileCacheDir: dir,
      });
      const first = await r1.resolve('http://meta.test/persisted.json');
      expect(first.source).toBe('network');

      // Rebuild resolver with a FRESH memory cache; it should still find
      // the file cache entry on disk.
      const r2 = new MetadataResolver({
        httpClient: makeHttp(),
        fileCacheDir: dir,
      });
      const second = await r2.resolve('http://meta.test/persisted.json');
      expect(second.source).toBe('fileCache');
      expect(second.parsed!.name).toBe('Persisted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the file cache dir if it does not yet exist', () => {
    const parent = mkdtempSync(join(tmpdir(), 'metaplex-mkdir-'));
    const child = join(parent, 'nested', 'cache-dir');
    try {
      new MetadataResolver({ httpClient: makeHttp(), fileCacheDir: child });
      expect(existsSync(child)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('evicts least-recently-used entries once cacheSize is exceeded', async () => {
    let hits = 0;
    const handler = (name: string) =>
      http.get(`http://meta.test/${name}.json`, () => {
        hits += 1;
        return HttpResponse.json({ name });
      });
    server.use(handler('a'), handler('b'), handler('c'), handler('d'));

    const r = new MetadataResolver({ httpClient: makeHttp(), cacheSize: 3 });
    await r.resolve('http://meta.test/a.json');
    await r.resolve('http://meta.test/b.json');
    await r.resolve('http://meta.test/c.json');
    await r.resolve('http://meta.test/d.json'); // evicts 'a'

    // 'a' is the LRU after inserting d → it is the one evicted.
    // A re-fetch of 'a' must go to the network.
    const second = await r.resolve('http://meta.test/a.json');
    expect(second.source).toBe('network');
    // Fetching 'a' just now evicted the new oldest ('b'). So 'c' and
    // 'd' remain in memory but 'b' does not.
    expect((await r.resolve('http://meta.test/c.json')).source).toBe(
      'memoryCache',
    );
    expect((await r.resolve('http://meta.test/d.json')).source).toBe(
      'memoryCache',
    );
    expect((await r.resolve('http://meta.test/b.json')).source).toBe(
      'network',
    );
    // 'a' fetched twice + 'b' fetched twice + c, d once each = 6.
    expect(hits).toBe(6);
  });

  it('clearCache() empties the in-memory tier but not the file tier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metaplex-clear-'));
    try {
      server.use(
        http.get('http://meta.test/clear.json', () =>
          HttpResponse.json({ name: 'Clear' }),
        ),
      );
      const r = new MetadataResolver({
        httpClient: makeHttp(),
        fileCacheDir: dir,
      });
      await r.resolve('http://meta.test/clear.json');
      r.clearCache();
      const again = await r.resolve('http://meta.test/clear.json');
      // File cache survived clearCache().
      expect(again.source).toBe('fileCache');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to network when the on-disk file is corrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metaplex-corrupt-'));
    try {
      server.use(
        http.get('http://meta.test/corrupt.json', () =>
          HttpResponse.json({ name: 'Recovered' }),
        ),
      );
      const r = new MetadataResolver({
        httpClient: makeHttp(),
        fileCacheDir: dir,
      });
      // Seed the cache.
      await r.resolve('http://meta.test/corrupt.json');
      r.clearCache();
      // Corrupt the file on disk.
      const { readdirSync, writeFileSync } = await import('node:fs');
      const files = readdirSync(dir);
      writeFileSync(join(dir, files[0]!), 'not json');
      const res = await r.resolve('http://meta.test/corrupt.json');
      expect(res.source).toBe('network');
      expect(res.parsed!.name).toBe('Recovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extractShape pure function
// ---------------------------------------------------------------------------

describe('extractShape', () => {
  it('rejects null root', () => {
    const out = extractShape(null);
    expect(out.parsed).toBeUndefined();
    expect(out.errors).toContain('root is not a JSON object');
  });

  it('rejects array root', () => {
    const out = extractShape([1, 2, 3]);
    expect(out.parsed).toBeUndefined();
    expect(out.errors).toContain('root is not a JSON object');
  });

  it('accepts object with only name', () => {
    const out = extractShape({ name: 'only' });
    expect(out.errors).toEqual([]);
    expect(out.parsed!.name).toBe('only');
  });

  it('flags wrong type for symbol/description/image', () => {
    const out = extractShape({
      name: 'x',
      symbol: 123,
      description: true,
      image: {},
    });
    expect(out.parsed!.name).toBe('x');
    expect(out.errors).toEqual(
      expect.arrayContaining([
        'symbol must be a string',
        'description must be a string',
        'image must be a string',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Default constructor — no httpClient provided
// ---------------------------------------------------------------------------

describe('MetadataResolver defaults', () => {
  it('constructs an internal HttpClient when none is passed', async () => {
    server.use(
      http.get('http://meta.test/defaults.json', () =>
        HttpResponse.json({ name: 'Defaults' }),
      ),
    );
    const r = new MetadataResolver();
    const res: ResolvedMetadata = await r.resolve(
      'http://meta.test/defaults.json',
    );
    expect(res.parsed!.name).toBe('Defaults');
  });
});

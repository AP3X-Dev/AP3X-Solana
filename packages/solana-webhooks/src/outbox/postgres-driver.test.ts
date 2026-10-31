// Driver contract tests; real SQL semantics remain covered by the PostgreSQL parity suite.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresOutbox } from './postgres.js';

const driver = vi.hoisted(() => {
  const query = vi.fn<(...args: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>>();
  const end = vi.fn<() => Promise<void>>();
  const Pool = vi.fn(function () { return { query, end }; });
  return { query, end, Pool };
});
vi.mock('pg', () => ({ Pool: driver.Pool }));

const config = { connectionString: 'postgres://local-test/unused' };
const event = { source: 'helius', id: "id'quoted", receivedAt: 1700000000000, rawPayload: new Uint8Array([0, 255, 42]) };

beforeEach(() => {
  driver.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  driver.end.mockReset().mockResolvedValue(undefined);
  driver.Pool.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('PostgresOutbox driver contract', () => {
  it.each(['bad.schema', 'quoted"schema', 'x; DROP TABLE webhook_events', '1schema'])('rejects unsafe schema %s before creating a connection', (schema) => {
    expect(() => new PostgresOutbox({ ...config, schema })).toThrow('identifier is not safe');
    expect(driver.Pool).not.toHaveBeenCalled();
  });

  it('passes pool settings, qualifies storage and initializes only once', async () => {
    const outbox = new PostgresOutbox({ ...config, schema: 'tenant_1', poolSize: 3, ssl: { rejectUnauthorized: true } });
    await outbox.init();
    await outbox.init();
    expect(driver.Pool).toHaveBeenCalledExactlyOnceWith({ ...config, max: 3, ssl: { rejectUnauthorized: true } });
    expect(driver.query.mock.calls.map(([sql]) => sql)).toEqual([
      'CREATE SCHEMA IF NOT EXISTS "tenant_1"',
      expect.stringContaining('CREATE TABLE IF NOT EXISTS "tenant_1".webhook_events'),
      expect.stringContaining('ON "tenant_1".webhook_events (received_at) WHERE processed_at IS NULL'),
    ]);
    await outbox.close();
  });

  it.each([false, true])('cleans up failed initialization, preserves the DDL error and allows retry (close fails: %s)', async (closeFails) => {
    const outbox = new PostgresOutbox(config);
    const ddlError = new Error('DDL denied');
    driver.query.mockRejectedValueOnce(ddlError);
    if (closeFails) driver.end.mockRejectedValueOnce(new Error('close failed'));
    await expect(outbox.init()).rejects.toBe(ddlError);
    expect(driver.end).toHaveBeenCalledOnce();
    await expect(outbox.countPending()).rejects.toThrow('not initialized');
    await outbox.init();
    expect(driver.Pool).toHaveBeenCalledTimes(2);
    expect(driver.Pool).toHaveBeenLastCalledWith(config);
    await outbox.close();
  });

  it('requires initialization for every operation and permits idempotent close', async () => {
    const outbox = new PostgresOutbox(config);
    for (const operation of [
      () => outbox.insert(event), () => outbox.pending({ limit: 1 }),
      () => outbox.markProcessed('source', 'id', 1),
      () => outbox.markFailed('source', 'id', 'error', 1), () => outbox.countPending(),
    ]) await expect(operation()).rejects.toThrow('not initialized');
    await outbox.close();
    await outbox.init();
    await outbox.close();
    await outbox.close();
    expect(driver.end).toHaveBeenCalledOnce();
    await expect(outbox.insert(event)).rejects.toThrow('not initialized');
  });

  it('parameterizes raw bytes and metadata, reporting duplicates and missing row counts', async () => {
    const outbox = new PostgresOutbox(config);
    await outbox.init();
    expect(await outbox.insert({ ...event, metadata: { provider: 'a"b' } })).toBe(true);
    expect(driver.query).toHaveBeenLastCalledWith(expect.stringContaining('ON CONFLICT (source, id) DO NOTHING'),
      [event.source, event.id, event.receivedAt, Buffer.from(event.rawPayload), '{"provider":"a\\"b"}']);
    expect(driver.query.mock.lastCall![0]).not.toContain(event.id);
    driver.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await outbox.insert(event)).toBe(false);
    expect(driver.query.mock.lastCall![1]).toEqual([event.source, event.id, event.receivedAt, Buffer.from(event.rawPayload), null]);
    driver.query.mockResolvedValueOnce({ rows: [], rowCount: null });
    expect(await outbox.insert(event)).toBe(false);
    await outbox.close();
  });

  it('applies retry bounds only for finite attempt limits and uses the requested cutoff', async () => {
    const outbox = new PostgresOutbox(config);
    await outbox.init();
    vi.spyOn(Date, 'now').mockReturnValue(10000);
    for (const opts of [{ limit: 4 }, { limit: 4, maxAttempts: Infinity }]) {
      expect(await outbox.pending(opts)).toEqual([]);
      expect(driver.query).toHaveBeenLastCalledWith(expect.not.stringContaining('attempts <'), [4]);
    }
    await outbox.pending({ limit: 4, maxAttempts: 3, retryDelayMs: 2000 });
    expect(driver.query).toHaveBeenLastCalledWith(expect.stringContaining('attempts < $1'), [3, 8000, 4]);
    await outbox.pending({ limit: 4, maxAttempts: 0 });
    expect(driver.query.mock.lastCall![1]).toEqual([0, 10000, 4]);
    await outbox.close();
  });

  it('decodes pg string numerics, JSON representations and byte buffers without aliasing', async () => {
    const outbox = new PostgresOutbox(config);
    await outbox.init();
    const bytes = Buffer.from([0, 255]);
    const base = { source: 'helius', id: 'a', received_at: '1700000000000', attempts: '2', raw_payload: bytes };
    driver.query.mockResolvedValueOnce({ rowCount: 3, rows: [
      { ...base, metadata: '{"tag":"a"}', processed_at: '1700000000001', error: 'retry' },
      { ...base, metadata: { tag: 'b' }, processed_at: null, error: null },
      { ...base, raw_payload: null, metadata: null },
    ] });
    const rows = await outbox.pending({ limit: 3 });
    expect(rows[0]).toEqual({ source: 'helius', id: 'a', receivedAt: 1700000000000, attempts: 2,
      rawPayload: new Uint8Array([0, 255]), metadata: { tag: 'a' }, processedAt: 1700000000001, error: 'retry' });
    expect(rows[1]).toMatchObject({ metadata: { tag: 'b' }, processedAt: null, error: null });
    expect(rows[2]).toEqual({ source: 'helius', id: 'a', receivedAt: 1700000000000, attempts: 2,
      rawPayload: new Uint8Array(), processedAt: null, error: null });
    bytes[0] = 9;
    expect(rows[0]!.rawPayload[0]).toBe(0);
    await outbox.close();
  });

  it('parameterizes processing and failure updates and rejects missing rows', async () => {
    const outbox = new PostgresOutbox(config);
    await outbox.init();
    await outbox.markProcessed('s', "i'", 123);
    expect(driver.query).toHaveBeenLastCalledWith(expect.stringContaining('SET processed_at = $1, error = NULL'), [123, 's', "i'"]);
    await outbox.markFailed('s', "i'", 'failed', 2);
    expect(driver.query).toHaveBeenLastCalledWith(expect.stringContaining('SET error = $1, attempts = $2'), ['failed', 2, 's', "i'"]);
    for (const rowCount of [0, null]) {
      driver.query.mockResolvedValueOnce({ rows: [], rowCount });
      await expect(outbox.markProcessed('s', 'missing', 1)).rejects.toThrow('no row');
      driver.query.mockResolvedValueOnce({ rows: [], rowCount });
      await expect(outbox.markFailed('s', 'missing', 'failed', 1)).rejects.toThrow('no row');
    }
    await outbox.close();
  });

  it('reads pending counts and propagates provider errors without returning fabricated success', async () => {
    const outbox = new PostgresOutbox(config);
    await outbox.init();
    driver.query.mockResolvedValueOnce({ rows: [{ n: '7' }], rowCount: 1 });
    expect(await outbox.countPending()).toBe(7);
    driver.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await outbox.countPending()).toBe(0);
    const error = new Error('connection lost');
    driver.query.mockRejectedValueOnce(error);
    await expect(outbox.insert(event)).rejects.toBe(error);
    driver.query.mockRejectedValueOnce(error);
    await expect(outbox.pending({ limit: 1 })).rejects.toBe(error);
    driver.end.mockRejectedValueOnce(error);
    await expect(outbox.close()).rejects.toBe(error);
    await outbox.close();
    await expect(outbox.countPending()).rejects.toThrow('not initialized');
  });
});

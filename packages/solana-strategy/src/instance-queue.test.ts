import { describe, it, expect } from 'vitest';
import { InstanceQueue } from './instance-queue.js';

describe('InstanceQueue', () => {
  it('serializes all enqueued tasks (no interleaving)', async () => {
    const q = new InstanceQueue();
    const log: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      log.push(`${label}-start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${label}-end`);
    };
    await Promise.all([q.enqueue(slow('a', 10)), q.enqueue(slow('b', 5)), q.enqueue(slow('c', 1))]);
    expect(log).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
  });

  it('plumbs return values through to the caller', async () => {
    const q = new InstanceQueue();
    const result = await q.enqueue(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('propagates errors to the caller and keeps the chain alive', async () => {
    const q = new InstanceQueue();
    const err = new Error('boom');
    await expect(q.enqueue(() => Promise.reject(err))).rejects.toBe(err);
    // Chain must survive — subsequent tasks still run.
    const result = await q.enqueue(() => Promise.resolve('still-alive'));
    expect(result).toBe('still-alive');
  });

  it('accepts sync (non-Promise) return values via widened signature', async () => {
    const q = new InstanceQueue();
    // `await` on a non-thenable returns the value directly, so sync tasks
    // work at zero overhead when the signature is () => Promise<T> | T.
    const result = await q.enqueue(() => 'sync');
    expect(result).toBe('sync');
  });
});

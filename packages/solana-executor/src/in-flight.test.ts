import { describe, it, expect } from 'vitest';
import { InFlightMap } from './in-flight.js';

describe('InFlightMap', () => {
  it('returns the same Promise for duplicate intentId until resolution', async () => {
    const map = new InFlightMap<string>();
    let calls = 0;
    const factory = () => new Promise<string>((res) => setTimeout(() => { calls++; res('done'); }, 10));
    const a = map.run('id1', factory);
    const b = map.run('id1', factory);
    expect(a).toBe(b);
    await a;
    expect(calls).toBe(1);
  });

  it('allows re-execution after the prior resolved', async () => {
    const map = new InFlightMap<string>();
    let calls = 0;
    const factory = () => new Promise<string>((res) => { calls++; res('done'); });
    await map.run('id1', factory);
    await map.run('id1', factory);
    expect(calls).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import { intentId } from './intent-id.js';

const BASE = {
  signalId: 'sig-abc123',
  strategyName: 'copy-trader',
  instanceId: 'whale-A',
};

describe('intentId', () => {
  it('1. determinism: same input → same output across 100 calls', () => {
    const first = intentId(BASE);
    for (let i = 0; i < 99; i++) {
      expect(intentId(BASE)).toBe(first);
    }
  });

  it('2. decisionVersion default: omitted === "v1"', () => {
    const withDefault = intentId(BASE);
    const withV1 = intentId({ ...BASE, decisionVersion: 'v1' });
    expect(withDefault).toBe(withV1);
  });

  it('3. decisionVersion bump: v1 !== v2', () => {
    const v1 = intentId({ ...BASE, decisionVersion: 'v1' });
    const v2 = intentId({ ...BASE, decisionVersion: 'v2' });
    expect(v1).not.toBe(v2);
  });

  it('4. multi-instance non-collision: whale-A !== whale-B', () => {
    const a = intentId({ ...BASE, instanceId: 'whale-A' });
    const b = intentId({ ...BASE, instanceId: 'whale-B' });
    expect(a).not.toBe(b);
  });

  it('5. cross-strategy non-collision: same signalId, different strategyName', () => {
    const x = intentId({ ...BASE, strategyName: 'copy-trader' });
    const y = intentId({ ...BASE, strategyName: 'momentum' });
    expect(x).not.toBe(y);
  });

  it('6. cross-signal non-collision: different signalId, same other fields', () => {
    const x = intentId({ ...BASE, signalId: 'sig-abc123' });
    const y = intentId({ ...BASE, signalId: 'sig-xyz789' });
    expect(x).not.toBe(y);
  });

  it('7. output shape: base58 alphabet, no padding', () => {
    const id = intentId(BASE);
    expect(/^[1-9A-HJ-NP-Za-km-z]+$/.test(id)).toBe(true);
  });

  it('8. NUL separator is load-bearing: "ab"+"c" !== "a"+"bc"', () => {
    // Without a NUL separator, concat('ab','c','d') === concat('a','bc','d')
    // because 'ab'+'c' and 'a'+'bc' are both the string 'abc'.
    // The separator ensures field boundaries are preserved.
    const abC = intentId({ signalId: 'ab', strategyName: 'c', instanceId: 'same-inst' });
    const aBC = intentId({ signalId: 'a', strategyName: 'bc', instanceId: 'same-inst' });
    expect(abC).not.toBe(aBC);
  });
});

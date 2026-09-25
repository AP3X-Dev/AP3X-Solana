import { describe, expect, it } from 'vitest';
import { eventKind } from './signal.js';

describe('eventKind', () => {
  it("uses the decoded event's own kind", () => {
    expect(eventKind({ kind: 'pumpfun.trade', mint: 'x' })).toBe('pumpfun.trade');
  });

  it("falls back to 'decoded' when the payload has no string kind", () => {
    expect(eventKind({})).toBe('decoded');
    expect(eventKind(null)).toBe('decoded');
    expect(eventKind({ kind: 3 })).toBe('decoded');
  });
});

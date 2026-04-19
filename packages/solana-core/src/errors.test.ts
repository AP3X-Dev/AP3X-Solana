import { describe, it, expect } from 'vitest';
import {
  Ap3xError,
  RpcError,
  DecodingError,
  TimeoutError,
  ConfigError,
} from './errors';

/**
 * The base class is abstract, so to exercise base-class invariants (message,
 * name, cause) independently of the four concrete subclasses we need a tiny
 * test-only concrete subclass. Declared at module scope rather than inside a
 * `describe` so the class name exposed at runtime via `.name` is stable.
 */
class TestError extends Ap3xError {
  readonly code = 'test';
}

describe('Ap3xError (base class)', () => {
  it('cannot be constructed directly — it is abstract', () => {
    // Compile-time: `new Ap3xError(...)` fails TS2511. Runtime: the class has
    // no concrete instances, but `abstract` isn't enforced at JS runtime, so
    // instead we assert the intended concrete-subclass pattern works.
    const err = new TestError('boom');
    expect(err).toBeInstanceOf(Ap3xError);
    expect(err).toBeInstanceOf(Error);
  });

  it('sets message to the constructor argument', () => {
    const err = new TestError('boom');
    expect(err.message).toBe('boom');
  });

  it('sets name to the subclass name (not "Error")', () => {
    const err = new TestError('boom');
    expect(err.name).toBe('TestError');
  });

  it('exposes a non-empty stack inherited from Error', () => {
    const err = new TestError('boom');
    expect(typeof err.stack).toBe('string');
    expect(err.stack && err.stack.length).toBeGreaterThan(0);
  });

  it('preserves cause when provided in options', () => {
    const root = new Error('root');
    const err = new TestError('boom', { cause: root });
    expect(err.cause).toBe(root);
  });

  it('leaves cause undefined when not provided', () => {
    const err = new TestError('boom');
    expect(err.cause).toBeUndefined();
  });

  it('accepts a non-Error cause (any unknown value)', () => {
    const err = new TestError('boom', { cause: { kind: 'oops', n: 42 } });
    expect(err.cause).toEqual({ kind: 'oops', n: 42 });
  });

  it('round-trips through throw/catch preserving instanceof', () => {
    try {
      throw new TestError('boom');
    } catch (caught) {
      expect(caught).toBeInstanceOf(TestError);
      expect(caught).toBeInstanceOf(Ap3xError);
      expect(caught).toBeInstanceOf(Error);
    }
  });
});

describe('RpcError', () => {
  it('builds with a sub-code and message only (meta defaults to {})', () => {
    const err = new RpcError('timeout', 'rpc timed out');
    expect(err.message).toBe('rpc timed out');
    expect(err.code).toBe('rpc.timeout');
    expect(err.meta).toEqual({});
  });

  it('namespaces all five sub-codes under rpc.<subcode>', () => {
    const subcodes = ['timeout', 'rate_limited', 'http', 'rpc_method', 'parse'] as const;
    for (const sc of subcodes) {
      const err = new RpcError(sc, 'boom');
      expect(err.code).toBe(`rpc.${sc}`);
    }
  });

  it('stores structured meta (endpoint, method, statusCode, rpcCode, retryAfterMs)', () => {
    const err = new RpcError(
      'http',
      'upstream 502',
      {
        endpoint: 'https://api.mainnet-beta.solana.com',
        method: 'getSlot',
        statusCode: 502,
      },
    );
    expect(err.meta.endpoint).toBe('https://api.mainnet-beta.solana.com');
    expect(err.meta.method).toBe('getSlot');
    expect(err.meta.statusCode).toBe(502);
  });

  it('preserves cause and meta when both supplied', () => {
    const root = new TypeError('fetch failed');
    const err = new RpcError(
      'http',
      'wrapped fetch failure',
      { endpoint: 'https://x', statusCode: 500 },
      { cause: root },
    );
    expect(err.cause).toBe(root);
    expect(err.meta.endpoint).toBe('https://x');
    expect(err.meta.statusCode).toBe(500);
  });

  it('is instanceof RpcError and Ap3xError and Error', () => {
    const err = new RpcError('rate_limited', 'slow down', { retryAfterMs: 1000 });
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toBeInstanceOf(Ap3xError);
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "RpcError"', () => {
    const err = new RpcError('parse', 'bad json');
    expect(err.name).toBe('RpcError');
  });
});

describe('DecodingError', () => {
  it('requires expected and actual in meta', () => {
    const err = new DecodingError('borsh: short read', {
      expected: 'u32 length prefix',
      actual: 'EOF at offset 4',
    });
    expect(err.meta.expected).toBe('u32 length prefix');
    expect(err.meta.actual).toBe('EOF at offset 4');
  });

  it('accepts optional programId, accountKey, byteOffset', () => {
    const err = new DecodingError('spl mint decode failed', {
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      accountKey: 'So11111111111111111111111111111111111111112',
      byteOffset: 42,
      expected: 'mint layout',
      actual: 'wrong discriminant',
    });
    expect(err.meta.programId).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(err.meta.accountKey).toBe('So11111111111111111111111111111111111111112');
    expect(err.meta.byteOffset).toBe(42);
  });

  it('has a stable code of "decode"', () => {
    const err = new DecodingError('x', { expected: 'a', actual: 'b' });
    expect(err.code).toBe('decode');
  });

  it('preserves cause', () => {
    const root = new Error('underlying buffer error');
    const err = new DecodingError('wrapping', { expected: 'a', actual: 'b' }, { cause: root });
    expect(err.cause).toBe(root);
  });

  it('is instanceof DecodingError and Ap3xError and Error', () => {
    const err = new DecodingError('x', { expected: 'a', actual: 'b' });
    expect(err).toBeInstanceOf(DecodingError);
    expect(err).toBeInstanceOf(Ap3xError);
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "DecodingError"', () => {
    const err = new DecodingError('x', { expected: 'a', actual: 'b' });
    expect(err.name).toBe('DecodingError');
  });
});

describe('TimeoutError', () => {
  it('requires op and timeoutMs in meta', () => {
    const err = new TimeoutError('getSlot timed out', {
      op: 'getSlot',
      timeoutMs: 30_000,
    });
    expect(err.meta.op).toBe('getSlot');
    expect(err.meta.timeoutMs).toBe(30_000);
  });

  it('has a stable code of "timeout"', () => {
    const err = new TimeoutError('x', { op: 'op', timeoutMs: 1 });
    expect(err.code).toBe('timeout');
  });

  it('preserves cause', () => {
    const root = new Error('AbortError');
    const err = new TimeoutError('x', { op: 'op', timeoutMs: 1 }, { cause: root });
    expect(err.cause).toBe(root);
  });

  it('is instanceof TimeoutError and Ap3xError and Error', () => {
    const err = new TimeoutError('x', { op: 'op', timeoutMs: 1 });
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toBeInstanceOf(Ap3xError);
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "TimeoutError"', () => {
    const err = new TimeoutError('x', { op: 'op', timeoutMs: 1 });
    expect(err.name).toBe('TimeoutError');
  });
});

describe('ConfigError', () => {
  it('requires field in meta; value and hint are optional', () => {
    const err = new ConfigError('rpc endpoint missing', {
      field: 'rpc.endpoint',
    });
    expect(err.meta.field).toBe('rpc.endpoint');
    expect(err.meta.value).toBeUndefined();
    expect(err.meta.hint).toBeUndefined();
  });

  it('accepts a value of any type (unknown)', () => {
    const err = new ConfigError('bad priority tier', {
      field: 'feeTier',
      value: { tier: 'ultra' },
      hint: 'must be one of low | med | high | turbo',
    });
    expect(err.meta.value).toEqual({ tier: 'ultra' });
    expect(err.meta.hint).toBe('must be one of low | med | high | turbo');
  });

  it('has a stable code of "config"', () => {
    const err = new ConfigError('x', { field: 'f' });
    expect(err.code).toBe('config');
  });

  it('preserves cause', () => {
    const root = new SyntaxError('JSON parse failed');
    const err = new ConfigError('x', { field: 'f' }, { cause: root });
    expect(err.cause).toBe(root);
  });

  it('is instanceof ConfigError and Ap3xError and Error', () => {
    const err = new ConfigError('x', { field: 'f' });
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(Ap3xError);
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "ConfigError"', () => {
    const err = new ConfigError('x', { field: 'f' });
    expect(err.name).toBe('ConfigError');
  });
});

describe('cross-subclass discrimination', () => {
  it('RpcError is not an instance of DecodingError (and vice versa)', () => {
    const rpc = new RpcError('http', 'x', { statusCode: 500 });
    const dec = new DecodingError('x', { expected: 'a', actual: 'b' });
    expect(rpc).not.toBeInstanceOf(DecodingError);
    expect(dec).not.toBeInstanceOf(RpcError);
  });

  it('all four subclasses are instances of Ap3xError', () => {
    const errs: Ap3xError[] = [
      new RpcError('timeout', 'x'),
      new DecodingError('x', { expected: 'a', actual: 'b' }),
      new TimeoutError('x', { op: 'o', timeoutMs: 1 }),
      new ConfigError('x', { field: 'f' }),
    ];
    for (const err of errs) {
      expect(err).toBeInstanceOf(Ap3xError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('each subclass has a distinct stable code', () => {
    const codes = new Set([
      new RpcError('timeout', 'x').code,
      new DecodingError('x', { expected: 'a', actual: 'b' }).code,
      new TimeoutError('x', { op: 'o', timeoutMs: 1 }).code,
      new ConfigError('x', { field: 'f' }).code,
    ]);
    expect(codes.size).toBe(4);
  });
});

describe('JSON serialization baseline', () => {
  // Node's built-in Error fields (`message`, `stack`, native `cause`) are
  // non-enumerable, but TypeScript class fields (our `name` override, `code`,
  // `meta`) are assigned via plain property writes, so they ARE enumerable
  // and DO show up in JSON.stringify. We pin that baseline here so a future
  // `toJSON` override is a conscious change, not a silent shape shift.
  it('JSON.stringify on an error does not throw', () => {
    const err = new RpcError('http', 'x', { statusCode: 500 });
    expect(() => JSON.stringify(err)).not.toThrow();
  });

  it('does not leak message or stack through plain JSON.stringify', () => {
    const err = new RpcError('http', 'sensitive-message', { statusCode: 500 });
    const json = JSON.stringify(err);
    // `message` and `stack` come from the built-in Error and are non-enumerable.
    expect(json).not.toContain('sensitive-message');
    expect(json).not.toContain('"stack"');
  });

  it('surfaces code and meta through plain JSON.stringify', () => {
    const err = new RpcError('http', 'x', { statusCode: 500 });
    const json = JSON.parse(JSON.stringify(err)) as {
      name?: string;
      code?: string;
      meta?: { statusCode?: number };
    };
    expect(json.name).toBe('RpcError');
    expect(json.code).toBe('rpc.http');
    expect(json.meta?.statusCode).toBe(500);
  });
});

import { describe, it, expect } from 'vitest';
import type { IncomingRequest } from '../types.js';
import { verifyAuthHeader } from './auth.js';

function mkReq(headers: Record<string, string | string[] | undefined>): IncomingRequest {
  return {
    method: 'POST',
    url: '/webhook',
    headers,
    body: new Uint8Array(),
  };
}

describe('verifyAuthHeader', () => {
  it('accepts a request whose Authorization header matches the secret', () => {
    const r = mkReq({ authorization: 'shared-secret-abc' });
    expect(verifyAuthHeader(r, 'shared-secret-abc')).toEqual({ ok: true });
  });

  it('accepts uppercase Authorization header', () => {
    const r = mkReq({ Authorization: 'shared-secret-abc' });
    expect(verifyAuthHeader(r, 'shared-secret-abc')).toEqual({ ok: true });
  });

  it('rejects requests without an Authorization header', () => {
    const r = mkReq({});
    expect(verifyAuthHeader(r, 'shared-secret-abc')).toEqual({
      ok: false,
      reason: 'missing-auth',
    });
  });

  it('rejects requests with an empty Authorization header', () => {
    const r = mkReq({ authorization: '' });
    expect(verifyAuthHeader(r, 'shared-secret-abc')).toEqual({
      ok: false,
      reason: 'missing-auth',
    });
  });

  it('rejects mismatched secret', () => {
    const r = mkReq({ authorization: 'wrong-secret' });
    expect(verifyAuthHeader(r, 'shared-secret-abc')).toEqual({
      ok: false,
      reason: 'invalid-auth',
    });
  });

  it('rejects when the supplied value is a prefix of the secret', () => {
    const r = mkReq({ authorization: 'shared' });
    expect(verifyAuthHeader(r, 'shared-secret-abc')).toEqual({
      ok: false,
      reason: 'invalid-auth',
    });
  });

  it('rejects when the supplied value extends the secret', () => {
    const r = mkReq({ authorization: 'shared-secret-abc-extra' });
    expect(verifyAuthHeader(r, 'shared-secret-abc')).toEqual({
      ok: false,
      reason: 'invalid-auth',
    });
  });

  it('uses the first value when the header arrives as an array', () => {
    const r = mkReq({ authorization: ['shared-secret-abc', 'shared-secret-abc'] });
    expect(verifyAuthHeader(r, 'shared-secret-abc')).toEqual({ ok: true });
  });

  it('handles non-ASCII secrets correctly', () => {
    const r = mkReq({ authorization: 'sécret-éé' });
    expect(verifyAuthHeader(r, 'sécret-éé')).toEqual({ ok: true });
  });
});

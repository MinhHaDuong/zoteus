import { describe, it, expect } from 'vitest';
import { ZoteroApiError, actionableMessage } from '../../src/api/errors.js';

const hdr = (h: Record<string, string>) => new Headers(h);

describe('actionableMessage', () => {
  it('explains a 412 version conflict and how to recover', () => {
    const msg = actionableMessage(412, '', hdr({ 'last-modified-version': '2114' }));
    expect(msg).toMatch(/changed on the server/i);
    expect(msg).toMatch(/2114/);
    expect(msg).toMatch(/re-fetch/i);
  });

  it('surfaces Retry-After for 429', () => {
    const msg = actionableMessage(429, '', hdr({ 'retry-after': '30' }));
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toMatch(/30/);
  });

  it('names the cause for 413 and 400', () => {
    expect(actionableMessage(413, 'Too many items', hdr({}))).toMatch(/too (large|many)/i);
    expect(actionableMessage(400, 'invalid itemType', hdr({}))).toMatch(/invalid itemType/);
  });
});

describe('ZoteroApiError', () => {
  it('carries status, retryAfter, and currentVersion', () => {
    const e = new ZoteroApiError({ status: 412, message: 'conflict', currentVersion: 2114 });
    expect(e.status).toBe(412);
    expect(e.currentVersion).toBe(2114);
    expect(e).toBeInstanceOf(Error);
  });
});

// tests/lib/redact.test.ts
import { describe, it, expect } from 'vitest';
import { redactArgs } from '../../src/lib/redact.js';

describe('redactArgs', () => {
  it('masks secret-ish keys, deeply, leaving safe keys', () => {
    const [out] = redactArgs([
      { username: 'bob', passcode: 'hunter2', nested: { zoteroKey: 'SECRET', apiKey: 'A', count: 3 } },
    ]) as [Record<string, unknown>];
    expect(out.username).toBe('bob');
    expect(out.passcode).toBe('[REDACTED]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.zoteroKey).toBe('[REDACTED]');
    expect(nested.apiKey).toBe('[REDACTED]');
    expect(nested.count).toBe(3);
  });
  it('passes strings/numbers through and handles arrays + cycles', () => {
    const cyc: Record<string, unknown> = { token: 'x' };
    cyc.self = cyc;
    const out = redactArgs(['plain', 42, [{ secret: 's' }], cyc]);
    expect(out[0]).toBe('plain');
    expect(out[1]).toBe(42);
    expect((out[2] as Array<Record<string, unknown>>)[0].secret).toBe('[REDACTED]');
    expect((out[3] as Record<string, unknown>).token).toBe('[REDACTED]');
  });
});

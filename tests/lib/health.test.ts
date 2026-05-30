// tests/lib/health.test.ts
import { describe, it, expect } from 'vitest';
import { liveness, makeReadiness, storeCheck } from '../../src/lib/health.js';

describe('liveness', () => {
  it('reports status/version/uptime', () => {
    const l = liveness('0.12.0', Date.now() - 1500);
    expect(l.status).toBe('ok');
    expect(l.version).toBe('0.12.0');
    expect(l.uptimeSec).toBeGreaterThanOrEqual(1);
  });
});

describe('makeReadiness', () => {
  it('aggregates ok=false when any check fails, and caches', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      return { ok: false, detail: 'down' };
    };
    const r = makeReadiness({ store: async () => ({ ok: true }), zotero: flaky }, 10_000);
    const a = await r();
    const b = await r(); // cached → flaky not called again
    expect(a.ok).toBe(false);
    expect(a.checks.store.ok).toBe(true);
    expect(a.checks.zotero.ok).toBe(false);
    expect(calls).toBe(1);
    expect(b.ok).toBe(false);
  });
});

describe('storeCheck', () => {
  it('ok when clientIds() does not throw; not-ok when it throws', async () => {
    expect(await storeCheck({ clientIds: () => [] } as never)()).toEqual({ ok: true });
    const bad = await storeCheck({
      clientIds: () => {
        throw new Error('boom');
      },
    } as never)();
    expect(bad.ok).toBe(false);
  });
});

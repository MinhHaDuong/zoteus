import { describe, it, expect, vi } from 'vitest';
import { EntitlementCache } from '../../src/billing/entitlement-cache.js';
import type { EntitlementProvider, EntitlementStatus } from '../../src/billing/entitlement.js';

const provider = (impl: () => Promise<EntitlementStatus>): EntitlementProvider & { calls: () => number } => {
  let n = 0;
  return { validate: async () => { n++; return impl(); }, calls: () => n };
};

describe('EntitlementCache', () => {
  it('serves a fresh check and caches within TTL', async () => {
    const p = provider(async () => ({ active: true }));
    const cache = new EntitlementCache(p, { ttlMs: 10_000, graceMs: 60_000 });
    expect((await cache.check(111, 'LK')).active).toBe(true);
    expect((await cache.check(111, 'LK')).active).toBe(true);
    expect(p.calls()).toBe(1); // second within TTL → no provider call
  });

  it('serves the last good verdict on a provider throw within grace', async () => {
    let mode: 'ok' | 'throw' = 'ok';
    const p = provider(async () => {
      if (mode === 'throw') throw new Error('polar down');
      return { active: true };
    });
    const cache = new EntitlementCache(p, { ttlMs: 0, graceMs: 60_000 });
    expect((await cache.check(111, 'LK')).active).toBe(true); // seeds last-good
    mode = 'throw';
    expect((await cache.check(111, 'LK')).active).toBe(true); // stale-while-degraded
  });

  it('fails closed once past the grace window', async () => {
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    let mode: 'ok' | 'throw' = 'ok';
    const p = provider(async () => {
      if (mode === 'throw') throw new Error('polar down');
      return { active: true };
    });
    const cache = new EntitlementCache(p, { ttlMs: 0, graceMs: 10_000 });
    await cache.check(111, 'LK');
    mode = 'throw';
    t += 20_000; // past grace
    expect((await cache.check(111, 'LK'))).toEqual({ active: false, reason: 'unknown' });
    now.mockRestore();
  });

  it('fails closed on first-contact uncertainty (no prior good verdict)', async () => {
    const p = provider(async () => { throw new Error('polar down'); });
    const cache = new EntitlementCache(p, { ttlMs: 0, graceMs: 60_000 });
    expect(await cache.check(111, 'LK')).toEqual({ active: false, reason: 'unknown' });
  });
});

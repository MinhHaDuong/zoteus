import { describe, it, expect } from 'vitest';
import { decide, type EntitlementStatus, type Binding } from '../../src/billing/entitlement.js';

const active: EntitlementStatus = { active: true, customerRef: 'cus_1', expiresAt: Date.now() + 86_400_000 };
const inactive = (reason: EntitlementStatus['reason']): EntitlementStatus => ({ active: false, reason });

describe('decide', () => {
  it('active + unbound → allow + bind', () => {
    const d = decide(active, undefined, 'LK', 111);
    expect(d).toEqual({ allow: true, bind: true });
  });
  it('active + bound to same user → allow, no re-bind', () => {
    const binding: Binding = { zoteroUserId: 111, boundAt: 1 };
    expect(decide(active, binding, 'LK', 111)).toEqual({ allow: true, bind: false });
  });
  it('active + bound to a different user → deny (shared key)', () => {
    const binding: Binding = { zoteroUserId: 222, boundAt: 1 };
    const d = decide(active, binding, 'LK', 111);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('bound_to_other');
  });
  it('inactive/expired/revoked/invalid → deny regardless of binding', () => {
    for (const r of ['invalid', 'expired', 'revoked', 'unknown'] as const) {
      expect(decide(inactive(r), undefined, 'LK', 111).allow).toBe(false);
      expect(decide(inactive(r), { zoteroUserId: 111, boundAt: 1 }, 'LK', 111).allow).toBe(false);
    }
  });
});

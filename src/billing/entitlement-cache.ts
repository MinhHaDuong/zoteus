import type { EntitlementProvider, EntitlementStatus } from './entitlement.js';

export interface EntitlementCacheOptions {
  ttlMs: number;
  graceMs: number;
}

interface Entry {
  /** Last verdict we acted on (may be stale). */
  status: EntitlementStatus;
  /** When `status` was fetched fresh from the provider. */
  at: number;
  /** Last time the provider returned an `active` verdict (basis for the grace window). */
  lastGoodAt?: number;
}

/**
 * Short-TTL entitlement cache keyed by `zoteroUserId`, wrapping an {@link EntitlementProvider}.
 *
 * - Within `ttlMs` of a fetch, the cached verdict is reused (no provider call).
 * - On a provider error: if the last *active* verdict is within `graceMs`, serve it
 *   (stale-while-degraded — don't punish payers for a provider outage); otherwise, or with
 *   no prior good verdict (first contact), fail closed (`active:false, reason:'unknown'`).
 */
export class EntitlementCache {
  private readonly entries = new Map<number, Entry>();
  constructor(
    private readonly provider: EntitlementProvider,
    private readonly opts: EntitlementCacheOptions,
  ) {}

  async check(zoteroUserId: number, key: string): Promise<EntitlementStatus> {
    const now = Date.now();
    const prev = this.entries.get(zoteroUserId);
    if (prev && now - prev.at < this.opts.ttlMs) return prev.status;

    let status: EntitlementStatus;
    try {
      status = await this.provider.validate(key);
    } catch {
      if (prev?.lastGoodAt !== undefined && now - prev.lastGoodAt <= this.opts.graceMs) {
        return prev.status; // serve last good within grace
      }
      const degraded: EntitlementStatus = { active: false, reason: 'unknown' };
      this.entries.set(zoteroUserId, { status: degraded, at: now, lastGoodAt: prev?.lastGoodAt });
      return degraded;
    }

    this.entries.set(zoteroUserId, {
      status,
      at: now,
      lastGoodAt: status.active ? now : prev?.lastGoodAt,
    });
    return status;
  }

  /** Drop any cached verdict for a user (e.g. after an operator unbind). */
  invalidate(zoteroUserId: number): void {
    this.entries.delete(zoteroUserId);
  }
}

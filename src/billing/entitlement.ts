/** Provider-agnostic entitlement model + the pure decision logic. No I/O lives here. */

/** Normalized verdict for a license key, independent of the upstream provider. */
export interface EntitlementStatus {
  active: boolean;
  /** Why a key is not active (or `unknown` when the provider could not be reached). */
  reason?: 'invalid' | 'expired' | 'revoked' | 'unknown';
  /** Opaque provider customer reference (never a secret). */
  customerRef?: string;
  /** Epoch ms the entitlement expires, when known. */
  expiresAt?: number;
}

/** Persisted 1:1 link between a license key and the Zotero account that claimed it. */
export interface Binding {
  zoteroUserId: number;
  boundAt: number; // epoch ms
}

/** Anything that can turn a license key into a normalized {@link EntitlementStatus}. */
export interface EntitlementProvider {
  validate(key: string): Promise<EntitlementStatus>;
}

export interface Decision {
  allow: boolean;
  /** True when an active, unbound key should now be bound to this `zoteroUserId`. */
  bind?: boolean;
  reason?: 'inactive' | 'bound_to_other';
}

/**
 * Pure gate decision. Active + no binding → allow and bind. Active + bound to the same
 * user → allow. Active + bound to a different user → deny (one key, one account).
 * Anything not active → deny.
 */
export function decide(
  status: EntitlementStatus,
  binding: Binding | undefined,
  _presentedKey: string,
  zoteroUserId: number,
): Decision {
  if (!status.active) return { allow: false, reason: 'inactive' };
  if (!binding) return { allow: true, bind: true };
  if (binding.zoteroUserId === zoteroUserId) return { allow: true, bind: false };
  return { allow: false, reason: 'bound_to_other' };
}

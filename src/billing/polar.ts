import type { RateLimitedFetcher } from '../api/http.js';
import type { Logger } from '../lib/logger.js';
import type { EntitlementProvider, EntitlementStatus } from './entitlement.js';

const POLAR_BASE = 'https://api.polar.sh';

export interface PolarClientOptions {
  apiKey: string;
  organizationId: string;
  fetcher: RateLimitedFetcher;
  baseUrl?: string;
  logger?: Logger;
}

interface PolarValidateResponse {
  status?: string; // 'granted' | 'expired' | 'revoked' | ...
  expires_at?: string | null;
  customer_id?: string;
}

/**
 * EntitlementProvider backed by Polar's public license-key validate endpoint
 * (`POST /v1/customer-portal/license-keys/validate`, no auth, ~3 req/s). The license key
 * travels only in the request body and is never logged. `POLAR_API_KEY` is held for the
 * (future) authenticated endpoints; the public validate call itself needs no Authorization
 * header, but we send it so org-scoped rate limits attribute to us.
 */
export class PolarClient implements EntitlementProvider {
  private readonly base: string;
  constructor(private readonly opts: PolarClientOptions) {
    this.base = opts.baseUrl ?? POLAR_BASE;
  }

  async validate(key: string): Promise<EntitlementStatus> {
    const url = `${this.base}/v1/customer-portal/license-keys/validate`;
    const res = await this.opts.fetcher.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ key, organization_id: this.opts.organizationId }),
    });
    if (res.status === 404 || res.status === 403) {
      return { active: false, reason: 'invalid' };
    }
    if (!res.ok) {
      // Surface to the cache, which decides grace vs. fail-closed. Never include the key.
      this.opts.logger?.warn(`Polar validate failed (status ${res.status})`);
      throw new Error(`Polar validate failed (status ${res.status})`);
    }
    const body = (await res.json().catch(() => ({}))) as PolarValidateResponse;
    return mapStatus(body);
  }
}

function mapStatus(body: PolarValidateResponse): EntitlementStatus {
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : undefined;
  switch (body.status) {
    case 'granted':
      return {
        active: true,
        customerRef: body.customer_id,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
      };
    case 'expired':
      return { active: false, reason: 'expired' };
    case 'revoked':
      return { active: false, reason: 'revoked' };
    default:
      return { active: false, reason: 'invalid' };
  }
}

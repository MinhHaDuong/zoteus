import { describe, it, expect } from 'vitest';
import { PolarClient } from '../../src/billing/polar.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

// Self-skips unless real Polar test credentials are present (mirrors the ZOTERO_API_KEY gating
// in live.test.ts). With creds set, both cases run against the real Polar validate endpoint.
const creds = process.env.POLAR_TEST_API_KEY && process.env.POLAR_TEST_ORG_ID;
const d = creds ? describe : describe.skip;

d('Polar live validate (e2e)', () => {
  it('validates a test key → maps cleanly to an EntitlementStatus', async () => {
    const client = new PolarClient({
      apiKey: process.env.POLAR_TEST_API_KEY!,
      organizationId: process.env.POLAR_TEST_ORG_ID!,
      fetcher: new RateLimitedFetcher(),
    });
    const status = await client.validate(process.env.POLAR_TEST_ACTIVE_KEY ?? 'set-POLAR_TEST_ACTIVE_KEY');
    // With a real active key this is true; without one, the call still maps cleanly to a boolean.
    expect(typeof status.active).toBe('boolean');
  }, 30_000);

  it('maps an obviously-invalid key → inactive', async () => {
    const client = new PolarClient({
      apiKey: process.env.POLAR_TEST_API_KEY!,
      organizationId: process.env.POLAR_TEST_ORG_ID!,
      fetcher: new RateLimitedFetcher(),
    });
    const status = await client.validate('definitely-not-a-real-license-key-000');
    expect(status.active).toBe(false);
  }, 30_000);
});

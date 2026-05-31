import { describe, it, expect, vi } from 'vitest';
import { PolarClient } from '../../src/billing/polar.js';
import { RateLimitedFetcher } from '../../src/api/http.js';
import type { Logger } from '../../src/lib/logger.js';

function clientWith(handler: (url: string, init?: RequestInit) => Response, logger?: Logger) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  const fetcher = new RateLimitedFetcher({ fetchImpl: fetchImpl as never, logger });
  return { client: new PolarClient({ apiKey: 'polar_oat_x', organizationId: 'org_1', fetcher }), fetchImpl };
}
const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('PolarClient', () => {
  it('maps granted → active with expiry + customer ref', async () => {
    const { client } = clientWith(() => ok({ status: 'granted', expires_at: '2027-01-01T00:00:00Z', customer_id: 'cus_9' }));
    const s = await client.validate('LK-1');
    expect(s.active).toBe(true);
    expect(s.customerRef).toBe('cus_9');
    expect(s.expiresAt).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });
  it('maps expired/revoked → inactive with matching reason', async () => {
    for (const [polarStatus, reason] of [['expired', 'expired'], ['revoked', 'revoked']] as const) {
      const { client } = clientWith(() => ok({ status: polarStatus }));
      const s = await client.validate('LK-1');
      expect(s.active).toBe(false);
      expect(s.reason).toBe(reason);
    }
  });
  it('maps a 404 → inactive/invalid', async () => {
    const { client } = clientWith(() => new Response('{}', { status: 404 }));
    const s = await client.validate('LK-missing');
    expect(s).toEqual({ active: false, reason: 'invalid' });
  });
  it('sends key + organization_id in the body, never in the query', async () => {
    const { client, fetchImpl } = clientWith(() => ok({ status: 'granted' }));
    await client.validate('SECRET-LK');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/v1/customer-portal/license-keys/validate');
    expect(url).not.toContain('SECRET-LK');
    const body = JSON.parse(String(init!.body));
    expect(body).toEqual({ key: 'SECRET-LK', organization_id: 'org_1' });
  });
  it('never logs the key', async () => {
    const lines: unknown[][] = [];
    const logger = { info: (...a: unknown[]) => lines.push(a), debug: (...a: unknown[]) => lines.push(a), warn: (...a: unknown[]) => lines.push(a), error: (...a: unknown[]) => lines.push(a) } as Logger;
    const { client } = clientWith(() => new Response('boom', { status: 500 }), logger);
    await expect(client.validate('SECRET-LK')).rejects.toBeTruthy();
    expect(JSON.stringify(lines)).not.toContain('SECRET-LK');
  });
});

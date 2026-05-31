import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkceChallenge from 'pkce-challenge';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';
import { buildOAuth } from '../../src/auth/router.js';
import { buildServer, createServer, ContextCache } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { FileEntitlementStore } from '../../src/billing/store.js';
import type { EntitlementProvider, EntitlementStatus } from '../../src/billing/entitlement.js';

let httpServer: Server | undefined;
const realFetch = globalThis.fetch;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
  vi.unstubAllGlobals();
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

// One Zotero user, request token 'REQTOK'.
function installMockZotero(): void {
  const form = (s: string) => new Response(s, { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('www.zotero.org/oauth/request')) return form('oauth_token=REQTOK&oauth_token_secret=SEC&oauth_callback_confirmed=true');
    if (url.includes('www.zotero.org/oauth/access')) return form('oauth_token=AT&oauth_token_secret=KEY_U&userID=777&username=ursula');
    if (url.includes('api.zotero.org/keys/current'))
      return new Response(JSON.stringify({ userID: 777, username: 'ursula', access: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  vi.stubGlobal('fetch', stub);
}

const authIdFrom = (html: string): string => /name="auth_id" value="([^"]+)"/.exec(html)![1]!;

async function setup(provider: EntitlementProvider): Promise<{ base: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'zoteus-lic-'));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    ZOTEUS_OAUTH_ENABLED: 'true',
    ZOTEUS_OAUTH_MODE: 'zotero',
    ZOTEUS_OAUTH_STORE: 'file',
    ZOTEUS_OAUTH_TOKEN_SECRET: 'tok-secret',
    ZOTEUS_DATA_DIR: dir,
    ZOTEUS_PUBLIC_URL: base,
    ZOTERO_OAUTH_CLIENT_KEY: 'ck',
    ZOTERO_OAUTH_CLIENT_SECRET: 'cs',
    ZOTEUS_LICENSE_ENABLED: 'true',
    POLAR_API_KEY: 'p',
    POLAR_ORGANIZATION_ID: 'o',
    ZOTEUS_LICENSE_CHECKOUT_URL: 'https://buy.polar.sh/x',
    ZOTEUS_LICENSE_CACHE_TTL_SEC: '1',
  } as unknown as NodeJS.ProcessEnv);
  const entStore = await FileEntitlementStore.open(join(dir, 'entitlements.json'), config.oauth.tokenSecret!);
  const oauth = (await buildOAuth(config, {}, { provider, store: entStore }))!;
  const { ctx } = await buildServer(config);
  const cache = new ContextCache(config, ctx);
  httpServer = await startHttp(async (authInfo) => createServer(await cache.resolve(authInfo)), { port, host: '127.0.0.1', oauth });
  return { base, dir };
}

describe('license gate (integration)', () => {
  it('renders the gate, proceeds on active, binds, and serves /mcp; lapse → 403', async () => {
    installMockZotero();
    let active = true;
    const provider: EntitlementProvider = {
      validate: async (): Promise<EntitlementStatus> => (active ? { active: true } : { active: false, reason: 'expired' }),
    };
    const { base, dir } = await setup(provider);
    try {
      // DCR + authorize → license gate page
      const reg = await realFetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://localhost:45999/cb'], token_endpoint_auth_method: 'none', client_name: 'Test' }),
      });
      const client = await reg.json();
      const { code_verifier, code_challenge } = await pkceChallenge();
      const authUrl = new URL(`${base}/authorize`);
      authUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: 'http://localhost:45999/cb',
        code_challenge,
        code_challenge_method: 'S256',
        state: 'st',
        scope: 'zoteus',
      }).toString();
      const gateHtml = await (await realFetch(authUrl)).text();
      expect(gateHtml).toContain('name="license_key"');

      // inactive first → 403 + subscribe link, no redirect
      active = false;
      const authId = authIdFrom(gateHtml);
      const denied = await realFetch(`${base}/license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ auth_id: authId, license_key: 'LK' }),
        redirect: 'manual',
      });
      expect(denied.status).toBe(403);
      expect(await denied.text()).toContain('https://buy.polar.sh/x');

      // active → 302 to zotero.org; the 403 path kept the pending entry but get a clean authId
      active = true;
      const authId2 = authIdFrom(await (await realFetch(authUrl)).text());
      const proceed = await realFetch(`${base}/license`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ auth_id: authId2, license_key: 'LK' }),
        redirect: 'manual',
      });
      expect(proceed.status).toBe(302);
      expect(proceed.headers.get('location')).toContain('zotero.org/oauth/authorize');

      const cb = await realFetch(`${base}/oauth/zotero/callback?oauth_token=REQTOK&oauth_verifier=V`, { redirect: 'manual' });
      expect(cb.status).toBe(302);
      const code = new URL(cb.headers.get('location')!).searchParams.get('code')!;
      const tok = await realFetch(`${base}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier,
          client_id: client.client_id,
          redirect_uri: 'http://localhost:45999/cb',
        }),
      });
      const tokens = await tok.json();
      expect(tokens.access_token).toBeTruthy();

      // /mcp works while active
      const okCall = await realFetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } } }),
      });
      expect(okCall.status).toBe(200);

      // subscription lapses → next /mcp (after TTL) → 403
      active = false;
      await new Promise((r) => setTimeout(r, 1100)); // TTL=1s
      const lapsed = await realFetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(lapsed.status).toBe(403);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

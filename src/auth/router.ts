import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { join } from 'node:path';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { ZoteusConfig } from '../config.js';
import { ZoteusOAuthProvider } from './provider.js';
import { MemoryStore, FileStore, type OAuthStore } from './store.js';

export interface BuiltOAuth {
  provider: ZoteusOAuthProvider;
  store: OAuthStore;
  issuerUrl: URL;
  resourceServerUrl: URL;
  resourceMetadataUrl: string;
  /** Hosts accepted by DNS-rebinding protection (issuer host + any operator overrides). */
  allowedHosts: string[];
  mount(app: Express): void;
}

/** Build the OAuth subsystem from config, or undefined when OAuth is disabled. */
export async function buildOAuth(
  config: ZoteusConfig,
  hooks: { onEvent?: (e: 'token_issued' | 'auth_failed') => void } = {},
): Promise<BuiltOAuth | undefined> {
  if (!config.oauth.enabled) return undefined;
  if (!config.oauth.publicUrl) {
    throw new Error('OAuth enabled but ZOTEUS_PUBLIC_URL missing');
  }

  const issuerUrl = new URL(config.oauth.publicUrl);
  const resourceServerUrl = new URL('/mcp', issuerUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const allowedHosts = [...new Set([issuerUrl.host, ...config.oauth.allowedHosts])];

  let store: OAuthStore;
  if (config.oauth.store === 'file') {
    if (!config.oauth.tokenSecret) throw new Error('store=file requires ZOTEUS_OAUTH_TOKEN_SECRET');
    store = await FileStore.open(join(config.dataDir, 'oauth-store.json'), config.oauth.tokenSecret);
  } else {
    store = new MemoryStore();
  }

  const provider = new ZoteusOAuthProvider({
    mode: config.oauth.mode,
    passcode: config.oauth.passcode,
    accessTokenTtlSec: config.oauth.accessTokenTtlSec,
    refreshTokenTtlSec: config.oauth.refreshTokenTtlSec,
    store,
    onEvent: hooks.onEvent,
    zotero:
      config.oauth.mode === 'zotero'
        ? {
            clientKey: config.oauth.zoteroClientKey!,
            clientSecret: config.oauth.zoteroClientSecret!,
            callbackUrl: new URL('/oauth/zotero/callback', issuerUrl).href,
            readOnly: config.readOnly,
          }
        : undefined,
  });

  // Throttle the custom consent/callback endpoints (the SDK rate-limits its own routes,
  // but /consent and /oauth/zotero/callback are ours). Combined with the per-auth_id
  // attempt cap in the provider this resists passcode brute force.
  const consentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    // Behind a TLS proxy/tunnel the server sets `trust proxy`; silence express-rate-limit's
    // X-Forwarded-For / trust-proxy advisories so they don't spam logs on every request.
    validate: { trustProxy: false, xForwardedForHeader: false },
    message: { error: 'too_many_requests', error_description: 'Too many consent attempts. Try again later.' },
  });

  return {
    provider,
    store,
    issuerUrl,
    resourceServerUrl,
    resourceMetadataUrl,
    allowedHosts,
    mount(app: Express): void {
      // Register the custom consent endpoints before the SDK router. The SDK
      // sub-routers only bind their own mount paths (/authorize, /token, ...)
      // and fall through otherwise, so these are not shadowed. No CORS here —
      // both are same-origin/top-level browser navigations, not cross-origin APIs.
      app.post('/consent', consentLimiter, express.urlencoded({ extended: false }), (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const authId = typeof body.auth_id === 'string' ? body.auth_id : '';
        const passcode = typeof body.passcode === 'string' ? body.passcode : '';
        void provider.completeConsent(authId, passcode, res);
      });
      // Zotero OAuth 1.0a callback (zotero mode). A top-level browser redirect from zotero.org.
      if (config.oauth.mode === 'zotero') {
        app.get('/oauth/zotero/callback', consentLimiter, (req, res) => {
          const oauthToken = typeof req.query.oauth_token === 'string' ? req.query.oauth_token : '';
          const verifier = typeof req.query.oauth_verifier === 'string' ? req.query.oauth_verifier : '';
          void provider.completeZoteroCallback(oauthToken, verifier, res);
        });
      }
      app.use(
        mcpAuthRouter({
          provider,
          issuerUrl,
          resourceServerUrl,
          scopesSupported: ['zoteus'],
          resourceName: 'Zoteus Zotero MCP server',
        }),
      );
    },
  };
}

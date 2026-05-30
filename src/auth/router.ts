import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { ZoteusConfig } from '../config.js';
import { ZoteusOAuthProvider } from './provider.js';

export interface BuiltOAuth {
  provider: ZoteusOAuthProvider;
  issuerUrl: URL;
  resourceServerUrl: URL;
  resourceMetadataUrl: string;
  /** Hosts accepted by DNS-rebinding protection (issuer host + any operator overrides). */
  allowedHosts: string[];
  mount(app: Express): void;
}

/** Build the OAuth subsystem from config, or undefined when OAuth is disabled. */
export function buildOAuth(config: ZoteusConfig): BuiltOAuth | undefined {
  if (!config.oauth.enabled) return undefined;
  if (!config.oauth.publicUrl || !config.oauth.passcode) {
    throw new Error('OAuth enabled but ZOTEUS_PUBLIC_URL/ZOTEUS_OAUTH_PASSCODE missing');
  }

  const issuerUrl = new URL(config.oauth.publicUrl);
  const resourceServerUrl = new URL('/mcp', issuerUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const allowedHosts = [...new Set([issuerUrl.host, ...config.oauth.allowedHosts])];

  const provider = new ZoteusOAuthProvider({
    passcode: config.oauth.passcode,
    accessTokenTtlSec: config.oauth.accessTokenTtlSec,
    refreshTokenTtlSec: config.oauth.refreshTokenTtlSec,
  });

  // Throttle the custom passcode endpoint (the SDK rate-limits its own routes,
  // but /consent is ours). Combined with the per-auth_id attempt cap in the
  // provider this resists passcode brute force.
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
    issuerUrl,
    resourceServerUrl,
    resourceMetadataUrl,
    allowedHosts,
    mount(app: Express): void {
      // Register the custom consent endpoint before the SDK router. The SDK
      // sub-routers only bind their own mount paths (/authorize, /token, ...)
      // and fall through otherwise, so this is not shadowed. No CORS here —
      // /consent is a same-origin browser form, not a cross-origin API.
      app.post('/consent', consentLimiter, express.urlencoded({ extended: false }), (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const authId = typeof body.auth_id === 'string' ? body.auth_id : '';
        const passcode = typeof body.passcode === 'string' ? body.passcode : '';
        void provider.completeConsent(authId, passcode, res);
      });
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

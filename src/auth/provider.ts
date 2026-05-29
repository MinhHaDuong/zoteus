import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { renderConsentPage } from './consent.js';

export interface ZoteusOAuthProviderOptions {
  passcode: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
}

interface PendingConsent {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  attempts: number;
  expiresAt: number; // ms
}
interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
}
interface StoredAccess {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // seconds since epoch (matches AuthInfo + SDK bearerAuth check)
}
interface StoredRefresh {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
}

const CONSENT_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const MAX_CONSENT_ATTEMPTS = 5;
const MAX_CLIENTS = 1000;

const newToken = (): string => randomBytes(32).toString('base64url');
const nowSec = (): number => Math.floor(Date.now() / 1000);
const hostOf = (uri: string): string => {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
};

/**
 * Zoteus's own OAuth 2.1 authorization server (single-tenant gating model).
 *
 * It issues short-lived opaque bearer tokens after a one-step passcode consent.
 * PKCE S256 verification is performed by the SDK token handler (which calls
 * {@link challengeForAuthorizationCode} then verifies the code_verifier). All
 * state lives in memory — fine for a single instance; see docs/remote-oauth.md.
 */
export class ZoteusOAuthProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pending = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, StoredCode>();
  private readonly access = new Map<string, StoredAccess>();
  private readonly refresh = new Map<string, StoredRefresh>();

  constructor(private readonly opts: ZoteusOAuthProviderOptions) {}

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => this.clients.get(id),
    registerClient: (info) => {
      const partial = info as Partial<OAuthClientInformationFull>;
      const client_id = partial.client_id ?? randomUUID();
      const full = {
        ...info,
        client_id,
        client_id_issued_at: partial.client_id_issued_at ?? nowSec(),
      } as OAuthClientInformationFull;
      this.capClients();
      this.clients.set(client_id, full);
      return full;
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    const authId = randomUUID();
    this.pending.set(authId, {
      clientId: client.client_id,
      clientName: client.client_name ?? client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      attempts: 0,
      expiresAt: Date.now() + CONSENT_TTL_MS,
    });
    this.sendConsent(res, 200, authId, client.client_name ?? client.client_id, params.redirectUri);
  }

  /**
   * Custom (non-SDK) endpoint: verify the operator passcode for a pending
   * authorization and either redirect with a code or re-prompt. Throttling +
   * a per-auth_id attempt cap live here and in the router rate limiter.
   */
  async completeConsent(authId: string, passcode: string, res: Response): Promise<void> {
    this.sweep();
    const pc = this.pending.get(authId);
    if (!pc || pc.expiresAt < Date.now()) {
      this.pending.delete(authId);
      this.sendConsent(res, 400, authId, 'this client', '', 'Session expired — please reconnect from the client.');
      return;
    }
    if (!timingSafeEqualStr(passcode, this.opts.passcode)) {
      pc.attempts += 1;
      if (pc.attempts >= MAX_CONSENT_ATTEMPTS) {
        this.pending.delete(authId);
        this.sendConsent(res, 429, authId, pc.clientName, hostOf(pc.redirectUri), 'Too many attempts — please reconnect from the client.');
        return;
      }
      this.sendConsent(res, 401, authId, pc.clientName, hostOf(pc.redirectUri), 'Incorrect passcode. Please try again.');
      return;
    }
    this.pending.delete(authId);
    const code = newToken();
    this.codes.set(code, {
      clientId: pc.clientId,
      redirectUri: pc.redirectUri,
      codeChallenge: pc.codeChallenge,
      scopes: pc.scopes,
      resource: pc.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(pc.redirectUri);
    target.searchParams.set('code', code);
    if (pc.state !== undefined) target.searchParams.set('state', pc.state);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && !redirectUriMatches(redirectUri, c.redirectUri)) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    this.codes.delete(authorizationCode); // one-time use
    return this.issueTokens(c.clientId, c.scopes, c.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const r = this.refresh.get(refreshToken);
    if (!r || r.clientId !== client.client_id || r.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    this.refresh.delete(refreshToken); // rotate
    const grantScopes = scopes && scopes.length ? scopes : r.scopes;
    return this.issueTokens(r.clientId, grantScopes, r.resource);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const a = this.access.get(accessToken);
    if (!a) throw new InvalidTokenError('Invalid access token');
    if (a.expiresAt < nowSec()) {
      this.access.delete(accessToken);
      throw new InvalidTokenError('Access token expired');
    }
    return {
      token: accessToken,
      clientId: a.clientId,
      scopes: a.scopes,
      expiresAt: a.expiresAt,
      resource: a.resource ? new URL(a.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.access.delete(request.token);
    this.refresh.delete(request.token);
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    this.access.set(accessToken, { clientId, scopes, resource, expiresAt: nowSec() + this.opts.accessTokenTtlSec });
    this.refresh.set(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + this.opts.refreshTokenTtlSec * 1000,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.opts.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: scopes.length ? scopes.join(' ') : undefined,
    };
  }

  private sendConsent(
    res: Response,
    status: number,
    authId: string,
    clientName: string,
    redirectUri: string,
    error?: string,
  ): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).send(renderConsentPage({ authId, clientName, redirectHost: hostOf(redirectUri), error }));
  }

  /** Drop expired pending consents, codes, access tokens, and refresh tokens. */
  private sweep(): void {
    const ms = Date.now();
    const sec = nowSec();
    for (const [k, v] of this.pending) if (v.expiresAt < ms) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < ms) this.codes.delete(k);
    for (const [k, v] of this.access) if (v.expiresAt < sec) this.access.delete(k);
    for (const [k, v] of this.refresh) if (v.expiresAt < ms) this.refresh.delete(k);
  }

  /** Bound the registered-client map (FIFO) to resist slow DCR-flood memory growth. */
  private capClients(): void {
    while (this.clients.size >= MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

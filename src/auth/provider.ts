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
import { MemoryStore, type OAuthStore, type StoredAccess, type StoredRefresh } from './store.js';
import { requestToken, accessToken, buildAuthorizeUrl } from './zotero-oauth.js';
import { isClientIdMetadataUrl, fetchClientMetadata, InMemoryCimdCache } from '../lib/cimd.js';

export interface ZoteroBridgeOptions {
  clientKey: string;
  clientSecret: string;
  callbackUrl: string;
  readOnly: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface CimdOptions {
  enabled: boolean;
  cacheTtlSec: number;
  maxBytes: number;
  allowedRedirectSchemes: string[];
  /** Host allowlist for CIMD client_ids (empty = any public host). */
  allowedHosts?: string[];
  fetchImpl?: typeof fetch;
  /** Hostname → IP resolver (test seam; defaults to DNS). */
  lookupImpl?: (hostname: string) => Promise<string[]>;
}

export interface ZoteusOAuthProviderOptions {
  mode: 'passcode' | 'zotero';
  passcode?: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  store?: OAuthStore;
  zotero?: ZoteroBridgeOptions;
  onEvent?: (event: 'token_issued' | 'auth_failed') => void;
  cimd?: CimdOptions;
}

interface ZoteroIdentity {
  zoteroKey: string;
  zoteroUserId: number;
  username: string;
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
  /** zotero mode: secret for the request token (the pending entry is keyed by the request token). */
  zoteroReqTokenSecret?: string;
}
interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
  identity?: ZoteroIdentity;
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
 * Zoteus's own OAuth 2.1 authorization server.
 *
 * Two consent strategies, selected by {@link ZoteusOAuthProviderOptions.mode}:
 * - `passcode` (single-tenant, M10): a one-step operator passcode gates issuance; tokens
 *   carry no Zotero identity, so they resolve to the shared operator library.
 * - `zotero` (multi-tenant, M11): consent bridges Zotero's OAuth 1.0a; each user logs into
 *   their own Zotero account and the issued bearer token carries that user's Zotero key +
 *   identity (surfaced in {@link AuthInfo.extra}).
 *
 * Durable state (clients, access/refresh tokens, per-user keys) lives in the injected
 * {@link OAuthStore} (in-memory by default, optionally an encrypted file). Short-lived
 * pending consents and auth codes stay in memory. PKCE S256 verification is performed by
 * the SDK token handler via {@link challengeForAuthorizationCode}.
 */
export class ZoteusOAuthProvider implements OAuthServerProvider {
  private readonly store: OAuthStore;
  private readonly pending = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, StoredCode>();
  private readonly cimdCache?: InMemoryCimdCache;

  constructor(private readonly opts: ZoteusOAuthProviderOptions) {
    this.store = opts.store ?? new MemoryStore();
    if (opts.mode === 'passcode' && !opts.passcode) throw new Error('passcode mode requires a passcode');
    if (opts.mode === 'zotero' && !opts.zotero) throw new Error('zotero mode requires zotero bridge options');
    if (opts.cimd?.enabled) this.cimdCache = new InMemoryCimdCache(opts.cimd.cacheTtlSec * 1000);
  }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: async (id) => {
      const known = this.store.getClient(id);
      if (known) return known;
      const cimd = this.opts.cimd;
      if (cimd?.enabled && this.cimdCache && isClientIdMetadataUrl(id)) {
        try {
          return await this.cimdCache.getOrLoad(id, () =>
            fetchClientMetadata(id, {
              maxBytes: cimd.maxBytes,
              allowedRedirectSchemes: cimd.allowedRedirectSchemes,
              allowedHosts: cimd.allowedHosts,
              fetchImpl: cimd.fetchImpl,
              lookupImpl: cimd.lookupImpl,
            }),
          );
        } catch {
          return undefined; // invalid/unreachable CIMD doc → treat as unknown client
        }
      }
      return undefined;
    },
    registerClient: (info) => {
      const partial = info as Partial<OAuthClientInformationFull>;
      const client_id = partial.client_id ?? randomUUID();
      const full = {
        ...info,
        client_id,
        client_id_issued_at: partial.client_id_issued_at ?? nowSec(),
      } as OAuthClientInformationFull;
      this.capClients();
      this.store.setClient(full);
      void this.store.flush();
      return full;
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    if (this.opts.mode === 'zotero') return this.authorizeViaZotero(client, params, res);
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

  /** zotero mode: start Zotero OAuth 1.0a and 302 the browser to zotero.org's authorize page. */
  private async authorizeViaZotero(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const z = this.opts.zotero!;
    const { oauthToken, oauthTokenSecret } = await requestToken(
      { clientKey: z.clientKey, clientSecret: z.clientSecret, callbackUrl: z.callbackUrl },
      { baseUrl: z.baseUrl, fetchImpl: z.fetchImpl },
    );
    // Key the pending consent by the Zotero request token so the callback can recover it.
    this.pending.set(oauthToken, {
      clientId: client.client_id,
      clientName: client.client_name ?? client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      attempts: 0,
      expiresAt: Date.now() + CONSENT_TTL_MS,
      zoteroReqTokenSecret: oauthTokenSecret,
    });
    res.redirect(302, buildAuthorizeUrl(oauthToken, { baseUrl: z.baseUrl, readOnly: z.readOnly }));
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
    if (!timingSafeEqualStr(passcode, this.opts.passcode ?? '')) {
      pc.attempts += 1;
      this.opts.onEvent?.('auth_failed');
      if (pc.attempts >= MAX_CONSENT_ATTEMPTS) {
        this.pending.delete(authId);
        this.sendConsent(res, 429, authId, pc.clientName, hostOf(pc.redirectUri), 'Too many attempts — please reconnect from the client.');
        return;
      }
      this.sendConsent(res, 401, authId, pc.clientName, hostOf(pc.redirectUri), 'Incorrect passcode. Please try again.');
      return;
    }
    this.pending.delete(authId);
    const code = this.mintCode(pc); // no identity → operator/shared tenant
    this.redirectWithCode(res, pc, code);
  }

  /**
   * Zotero OAuth 1.0a callback: exchange the verifier for the per-user key, then mint a
   * user-bound auth code and complete the OAuth 2.1 flow (302 back to the client).
   */
  async completeZoteroCallback(oauthToken: string, verifier: string, res: Response): Promise<void> {
    this.sweep();
    const pc = this.pending.get(oauthToken);
    if (!pc || pc.expiresAt < Date.now() || !pc.zoteroReqTokenSecret) {
      this.pending.delete(oauthToken);
      this.sendConsent(res, 400, oauthToken, 'this client', '', 'Session expired — please reconnect from the client.');
      return;
    }
    this.pending.delete(oauthToken);
    const z = this.opts.zotero!;
    let identity: ZoteroIdentity;
    try {
      identity = await accessToken(
        {
          clientKey: z.clientKey,
          clientSecret: z.clientSecret,
          oauthToken,
          oauthTokenSecret: pc.zoteroReqTokenSecret,
          verifier,
        },
        { baseUrl: z.baseUrl, fetchImpl: z.fetchImpl },
      );
    } catch {
      this.sendConsent(res, 502, oauthToken, pc.clientName, hostOf(pc.redirectUri), 'Could not complete Zotero sign-in. Please try again.');
      return;
    }
    const code = this.mintCode(pc, identity);
    this.redirectWithCode(res, pc, code);
  }

  /** Mint a one-time auth code for a completed consent, optionally bound to a Zotero identity. */
  private mintCode(pc: PendingConsent, identity?: ZoteroIdentity): string {
    const code = newToken();
    this.codes.set(code, {
      clientId: pc.clientId,
      redirectUri: pc.redirectUri,
      codeChallenge: pc.codeChallenge,
      scopes: pc.scopes,
      resource: pc.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
      identity,
    });
    return code;
  }

  private redirectWithCode(res: Response, pc: PendingConsent, code: string): void {
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
    return this.issueTokens(c.clientId, c.scopes, c.resource, c.identity);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const r = this.store.getRefresh(refreshToken);
    if (!r || r.clientId !== client.client_id || r.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    this.store.deleteRefresh(refreshToken); // rotate
    const grantScopes = scopes && scopes.length ? scopes : r.scopes;
    const identity = identityOf(r);
    return this.issueTokens(r.clientId, grantScopes, r.resource, identity);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const a = this.store.getAccess(accessToken);
    if (!a) throw new InvalidTokenError('Invalid access token');
    if (a.expiresAt < nowSec()) {
      this.store.deleteAccess(accessToken);
      throw new InvalidTokenError('Access token expired');
    }
    const identity = identityOf(a);
    return {
      token: accessToken,
      clientId: a.clientId,
      scopes: a.scopes,
      expiresAt: a.expiresAt,
      resource: a.resource ? new URL(a.resource) : undefined,
      extra: identity ? { ...identity } : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.deleteAccess(request.token);
    this.store.deleteRefresh(request.token);
    void this.store.flush();
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string, identity?: ZoteroIdentity): OAuthTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    const idFields = identity
      ? { zoteroKey: identity.zoteroKey, zoteroUserId: identity.zoteroUserId, username: identity.username }
      : {};
    const accessRec: StoredAccess = {
      clientId,
      scopes,
      resource,
      expiresAt: nowSec() + this.opts.accessTokenTtlSec,
      ...idFields,
    };
    const refreshRec: StoredRefresh = {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + this.opts.refreshTokenTtlSec * 1000,
      ...idFields,
    };
    this.store.setAccess(accessToken, accessRec);
    this.store.setRefresh(refreshToken, refreshRec);
    void this.store.flush();
    this.opts.onEvent?.('token_issued');
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

  /** Drop expired pending consents and codes; sweep expired tokens in the store. */
  private sweep(): void {
    const ms = Date.now();
    const sec = nowSec();
    for (const [k, v] of this.pending) if (v.expiresAt < ms) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < ms) this.codes.delete(k);
    this.store.sweepExpired(sec, ms);
  }

  /** Bound the registered-client store (FIFO) to resist slow DCR-flood memory growth. */
  private capClients(): void {
    const ids = this.store.clientIds();
    let i = 0;
    while (ids.length - i >= MAX_CLIENTS && i < ids.length) {
      this.store.deleteClient(ids[i]!);
      i += 1;
    }
  }
}

function identityOf(rec: StoredAccess | StoredRefresh): ZoteroIdentity | undefined {
  if (rec.zoteroKey && rec.zoteroUserId !== undefined) {
    return { zoteroKey: rec.zoteroKey, zoteroUserId: rec.zoteroUserId, username: rec.username ?? String(rec.zoteroUserId) };
  }
  return undefined;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

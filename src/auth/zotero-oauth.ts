import { createHmac, randomBytes } from 'node:crypto';

const ZOTERO_BASE = 'https://www.zotero.org';
const ZOTERO_API_BASE = 'https://api.zotero.org';

/** RFC 3986 percent-encoding (OAuth 1.0a §3.6): only A-Z a-z 0-9 - . _ ~ stay literal. */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Build the RFC 5849 §3.4.1 signature base string from method, base URL, and all (oauth_+query+body) params. */
export function buildSignatureBaseString(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
): string {
  const normalized = Object.keys(params)
    .map((k) => [percentEncode(k), percentEncode(params[k]!)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return [method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join('&');
}

/** HMAC-SHA1 signature (base64) with key = percentEncode(consumerSecret)&percentEncode(tokenSecret). */
export function signHmacSha1(baseString: string, consumerSecret: string, tokenSecret = ''): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac('sha1', key).update(baseString).digest('base64');
}

interface SignedHeaderInput {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  /** additional oauth_* params, e.g. oauth_callback / oauth_verifier */
  extra?: Record<string, string>;
}

/** Compose the `Authorization: OAuth ...` header for a signed request. */
function authorizationHeader(input: SignedHeaderInput): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(input.token ? { oauth_token: input.token } : {}),
    ...(input.extra ?? {}),
  };
  const base = buildSignatureBaseString(input.method, input.url, oauth);
  oauth.oauth_signature = signHmacSha1(base, input.consumerSecret, input.tokenSecret ?? '');
  const header = Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k]!)}"`)
    .join(', ');
  return `OAuth ${header}`;
}

export interface ZoteroOAuthOptions {
  baseUrl?: string;
  /** Web API base used to validate the issued key (defaults to https://api.zotero.org). */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function postForm(
  url: string,
  authHeader: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, string>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zotero OAuth request to ${url} failed (${res.status}). ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  return Object.fromEntries(new URLSearchParams(text));
}

export interface RequestTokenInput {
  clientKey: string;
  clientSecret: string;
  callbackUrl: string;
}

/** Step 1: get a temporary request token + secret from /oauth/request. */
export async function requestToken(
  input: RequestTokenInput,
  opts: ZoteroOAuthOptions = {},
): Promise<{ oauthToken: string; oauthTokenSecret: string }> {
  const baseUrl = opts.baseUrl ?? ZOTERO_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrl}/oauth/request`;
  const header = authorizationHeader({
    method: 'POST',
    url,
    consumerKey: input.clientKey,
    consumerSecret: input.clientSecret,
    extra: { oauth_callback: input.callbackUrl },
  });
  const parsed = await postForm(url, header, fetchImpl);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error('Zotero OAuth /oauth/request returned no token pair');
  }
  return { oauthToken: parsed.oauth_token, oauthTokenSecret: parsed.oauth_token_secret };
}

export interface AccessTokenInput {
  clientKey: string;
  clientSecret: string;
  oauthToken: string;
  oauthTokenSecret: string;
  verifier: string;
}

/** Step 3: exchange the authorized request token for the permanent per-user key + identity. */
export async function accessToken(
  input: AccessTokenInput,
  opts: ZoteroOAuthOptions = {},
): Promise<{ zoteroUserId: number; username: string; zoteroKey: string }> {
  const baseUrl = opts.baseUrl ?? ZOTERO_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrl}/oauth/access`;
  const header = authorizationHeader({
    method: 'POST',
    url,
    consumerKey: input.clientKey,
    consumerSecret: input.clientSecret,
    token: input.oauthToken,
    tokenSecret: input.oauthTokenSecret,
    extra: { oauth_verifier: input.verifier },
  });
  const parsed = await postForm(url, header, fetchImpl);
  const userId = Number(parsed.userID);
  if (!Number.isFinite(userId)) {
    throw new Error('Zotero OAuth /oauth/access returned no numeric userID');
  }
  // Per Zotero's OAuth docs, the access response's oauth_token and oauth_token_secret are the
  // same value: the permanent Zotero API key. We verify it against the Web API, but a
  // *non-definitive* failure (timeout, 429/5xx throttle) must NOT hard-fail a valid key — only
  // a definitive 401/403 means the key is bad. Otherwise fall back to the documented field so a
  // momentary Zotero throttle can't turn a good key into a 502.
  const apiBaseUrl = opts.apiBaseUrl ?? ZOTERO_API_BASE;
  const documentedKey = (parsed.oauth_token_secret ?? '').trim() || (parsed.oauth_token ?? '').trim();
  const candidates = [parsed.oauth_token_secret, parsed.oauth_token]
    .map((v) => (v ?? '').trim())
    .filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);
  if (candidates.length === 0) {
    throw new Error('Zotero OAuth /oauth/access returned no key');
  }
  let sawTransient = false;
  for (const key of candidates) {
    const verdict = await keyVerdict(apiBaseUrl, key, fetchImpl);
    if (verdict === 'valid') {
      return { zoteroUserId: userId, username: parsed.username ?? String(userId), zoteroKey: key };
    }
    if (verdict === 'unknown') sawTransient = true;
  }
  // Nothing confirmed valid. If a check was inconclusive (throttle/network), degrade to the
  // documented key rather than failing the user; only throw when Zotero *definitively* rejected
  // every candidate (so a genuinely broken setup still surfaces loudly).
  if (sawTransient) {
    return { zoteroUserId: userId, username: parsed.username ?? String(userId), zoteroKey: documentedKey };
  }
  throw new Error('Zotero OAuth succeeded but the returned key was rejected by the Zotero Web API');
}

/** Probe a candidate key: 'valid' (200), 'invalid' (definitive 401/403), or 'unknown' (transient). */
async function keyVerdict(
  apiBaseUrl: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<'valid' | 'invalid' | 'unknown'> {
  try {
    const res = await fetchImpl(`${apiBaseUrl}/keys/current`, {
      method: 'GET',
      headers: { 'Zotero-API-Key': key, 'Zotero-API-Version': '3' },
    });
    if (res.ok) return 'valid';
    if (res.status === 401 || res.status === 403) return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Step 2: the URL the user's browser visits to approve. read-only scopes by default. */
export function buildAuthorizeUrl(
  oauthToken: string,
  opts: { baseUrl?: string; readOnly: boolean; name?: string },
): string {
  const baseUrl = opts.baseUrl ?? ZOTERO_BASE;
  const url = new URL(`${baseUrl}/oauth/authorize`);
  url.searchParams.set('oauth_token', oauthToken);
  // NB: do NOT set `identity=1` — that puts Zotero in identity-only mode and returns the
  // literal sentinel "identity" instead of a real API key (every request then 403s → users/0).
  // The userID/username come back in the /oauth/access response regardless of this param.
  url.searchParams.set('name', opts.name ?? 'Zoteus');
  url.searchParams.set('library_access', '1');
  // notes are readable library content; visibility is always granted. write_access /
  // all_groups are the mutation gates that read-only mode pins to 0 / read.
  url.searchParams.set('notes_access', '1');
  url.searchParams.set('write_access', opts.readOnly ? '0' : '1');
  url.searchParams.set('all_groups', opts.readOnly ? 'read' : 'write');
  return url.href;
}

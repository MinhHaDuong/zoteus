// Client ID Metadata Document (CIMD) support: resolve a URL `client_id` to a registered
// client by fetching + validating a metadata document, without Dynamic Client Registration.
// Used by directory-scale connectors (one shared app) instead of per-connection DCR.
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface CimdFetchOptions {
  maxBytes: number;
  allowedRedirectSchemes: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** A client_id is a CIMD reference iff it is a well-formed https URL. */
export function isClientIdMetadataUrl(clientId: string): boolean {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}

/**
 * Fetch and validate a client-metadata document. Enforces: https-only URL, a byte cap,
 * JSON parse, `client_id` === the document URL, and allowed redirect_uri schemes.
 * Returns a full client record (token_endpoint_auth_method defaults to 'none' — public client).
 */
export async function fetchClientMetadata(
  clientId: string,
  opts: CimdFetchOptions,
): Promise<OAuthClientInformationFull> {
  if (!isClientIdMetadataUrl(clientId)) {
    throw new Error('CIMD client_id must be an https URL');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  let text: string;
  try {
    const res = await doFetch(clientId, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`CIMD fetch failed: status ${res.status}`);
    text = await res.text();
  } finally {
    clearTimeout(t);
  }
  if (Buffer.byteLength(text, 'utf8') > opts.maxBytes) {
    throw new Error('CIMD document too large');
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('CIMD document is not valid JSON');
  }
  if (doc.client_id !== clientId) {
    throw new Error('CIMD client_id must equal the document URL');
  }
  const redirectUris = Array.isArray(doc.redirect_uris) ? (doc.redirect_uris as unknown[]) : [];
  if (redirectUris.length === 0) {
    throw new Error('CIMD document has no redirect_uris');
  }
  for (const r of redirectUris) {
    let scheme: string;
    try {
      scheme = new URL(String(r)).protocol.replace(/:$/, '');
    } catch {
      throw new Error('CIMD redirect_uri is not a valid URL');
    }
    if (!opts.allowedRedirectSchemes.includes(scheme)) {
      throw new Error(`CIMD redirect_uri scheme not allowed: ${scheme}`);
    }
  }
  return {
    ...doc,
    client_id: clientId,
    redirect_uris: redirectUris.map(String),
    token_endpoint_auth_method:
      typeof doc.token_endpoint_auth_method === 'string' ? doc.token_endpoint_auth_method : 'none',
  } as OAuthClientInformationFull;
}

/** TTL cache for resolved CIMD clients (keyed by the URL client_id). */
export class InMemoryCimdCache {
  private readonly entries = new Map<string, { at: number; value: OAuthClientInformationFull }>();
  /** Overridable clock (tests). */
  now: () => number = () => Date.now();
  constructor(private readonly ttlMs: number) {}

  async getOrLoad(
    key: string,
    loader: () => Promise<OAuthClientInformationFull>,
  ): Promise<OAuthClientInformationFull> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = await loader();
    this.entries.set(key, { at: this.now(), value });
    return value;
  }
}

import type { OAuthStore } from '../auth/store.js';

export interface CheckResult {
  ok: boolean;
  detail?: string;
}
export interface Readiness {
  ok: boolean;
  checks: Record<string, CheckResult>;
}
export type Check = () => Promise<CheckResult>;

export function liveness(version: string, startedAtMs: number): { status: 'ok'; version: string; uptimeSec: number } {
  return { status: 'ok', version, uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000) };
}

/** Build a readiness probe that runs the given checks and caches the aggregate for cacheMs. */
export function makeReadiness(checks: Record<string, Check>, cacheMs: number): () => Promise<Readiness> {
  let cached: { at: number; value: Readiness } | undefined;
  return async () => {
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, fn]) => {
        try {
          return [name, await fn()] as const;
        } catch (e) {
          return [name, { ok: false, detail: e instanceof Error ? e.message : String(e) }] as const;
        }
      }),
    );
    const result: Readiness = { ok: entries.every(([, c]) => c.ok), checks: Object.fromEntries(entries) };
    cached = { at: Date.now(), value: result };
    return result;
  };
}

/** Readiness check: the OAuth store is loaded and queryable. */
export function storeCheck(store: OAuthStore | undefined): Check {
  return async () => {
    if (!store) return { ok: true, detail: 'no-store' };
    try {
      store.clientIds();
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** Readiness check: the Zotero Web API is reachable (no key; short timeout). */
export function zoteroPingCheck(opts: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Check {
  const url = opts.url ?? 'https://api.zotero.org/';
  const timeoutMs = opts.timeoutMs ?? 3000;
  const doFetch = opts.fetchImpl ?? fetch;
  return async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method: 'HEAD', signal: ctrl.signal });
      return res.ok || res.status === 404 ? { ok: true } : { ok: false, detail: `status ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(t);
    }
  };
}

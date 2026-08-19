import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from './logger.js';

const RELEASES_LATEST_URL = 'https://api.github.com/repos/oscardvs/zoteus/releases/latest';
export const RELEASES_PAGE_URL = 'https://github.com/oscardvs/zoteus/releases/latest';
/** At most one network check per day; failed attempts are cached too. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
}

interface CacheEntry {
  checkedAt: string;
  latest?: string;
  url?: string;
}

/** true when `a` is a strictly newer dotted-numeric version than `b`; non-numeric parts are never "newer". */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Manually installed builds (the Claude desktop .dxt in particular) have no update
 * channel, so users can sit on old versions without knowing. This checker asks GitHub
 * for the latest release tag and exposes the result for zotero_whoami to surface.
 * The request is a bare unauthenticated GET (no user data), it runs off the hot path,
 * and every failure mode degrades to "no notice".
 */
export class UpdateChecker {
  private info: UpdateInfo | null = null;
  private readonly cachePath: string;

  constructor(
    private readonly opts: {
      currentVersion: string;
      dataDir: string;
      logger: Logger;
      enabled: boolean;
      fetchImpl?: typeof globalThis.fetch;
    },
  ) {
    this.cachePath = join(opts.dataDir, 'update-check.json');
  }

  /** Newer published release, if one is known. */
  get available(): UpdateInfo | null {
    return this.info;
  }

  /** Fire-and-forget from startup: never rejects, never blocks a tool call. */
  async start(): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const latest = await this.latestRelease();
      if (latest && isNewerVersion(latest.version, this.opts.currentVersion)) {
        this.info = { current: this.opts.currentVersion, latest: latest.version, url: latest.url };
        this.opts.logger.info(
          `Update available: Zoteus ${latest.version} (running ${this.opts.currentVersion}). ${latest.url}`,
        );
      }
    } catch {
      // The update check must never affect the server.
    }
  }

  private async latestRelease(): Promise<{ version: string; url: string } | null> {
    const cached = await this.readCache();
    if (cached && Date.now() - Date.parse(cached.checkedAt) < CACHE_TTL_MS) {
      return cached.latest ? { version: cached.latest, url: cached.url ?? RELEASES_PAGE_URL } : null;
    }
    const entry: CacheEntry = { checkedAt: new Date().toISOString() };
    try {
      const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      let res: Response;
      try {
        res = await fetchImpl(RELEASES_LATEST_URL, {
          signal: controller.signal,
          headers: {
            'User-Agent': `zoteus/${this.opts.currentVersion}`,
            Accept: 'application/vnd.github+json',
          },
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        const body = (await res.json()) as { tag_name?: string; html_url?: string };
        const version = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : undefined;
        if (version) {
          entry.latest = version;
          entry.url = typeof body.html_url === 'string' ? body.html_url : RELEASES_PAGE_URL;
        }
      }
    } catch {
      // Offline or blocked: fall through and cache the attempt time so the next
      // sessions today do not retry.
    }
    await this.writeCache(entry);
    return entry.latest ? { version: entry.latest, url: entry.url ?? RELEASES_PAGE_URL } : null;
  }

  private async readCache(): Promise<CacheEntry | null> {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, 'utf8')) as CacheEntry;
      return typeof parsed?.checkedAt === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeCache(entry: CacheEntry): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(entry), 'utf8');
    } catch {
      // Best effort: an unwritable data dir just means a re-check next session.
    }
  }
}

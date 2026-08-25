import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults with an empty env', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.libraryType).toBe('user');
    expect(cfg.local).toBe('auto');
    expect(cfg.localPort).toBe(23119);
    expect(cfg.translationServerUrl).toBe('http://127.0.0.1:1969');
    expect(cfg.embeddings).toBe('local');
    // Unset: each provider keeps its own model, batch size and (absent) inter-batch pause.
    expect(cfg.embeddingModel).toBeUndefined();
    expect(cfg.embedBatchSize).toBeUndefined();
    expect(cfg.embedBatchDelayMs).toBe(0);
    // Full-text indexing is opt-in: it multiplies build time and index size.
    expect(cfg.indexFulltext).toBe(false);
    expect(cfg.indexFulltextMaxChars).toBe(40000);
    expect(cfg.allowDelete).toBe(false);
    expect(cfg.readOnly).toBe(false);
    expect(cfg.scholarProviders).toEqual(['openalex']);
    expect(typeof cfg.dataDir).toBe('string');
  });

  it('reads values from env and coerces types', () => {
    const cfg = loadConfig({
      ZOTERO_API_KEY: 'abc',
      ZOTERO_LIBRARY_ID: '19552201',
      ZOTERO_LIBRARY_TYPE: 'group',
      ZOTEUS_LOCAL: 'off',
      ZOTERO_LOCAL_PORT: '24000',
      ZOTEUS_ALLOW_DELETE: 'true',
      ZOTEUS_SCHOLAR_PROVIDERS: 'openalex,crossref',
      ZOTEUS_INDEX_FULLTEXT: 'true',
      ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: '0',
      ZOTEUS_EMBEDDING_MODEL: 'text-embedding-3-large',
      ZOTEUS_EMBED_BATCH_SIZE: '16',
      ZOTEUS_EMBED_BATCH_DELAY_MS: '500',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('abc');
    expect(cfg.libraryId).toBe(19552201);
    expect(cfg.libraryType).toBe('group');
    expect(cfg.local).toBe('off');
    expect(cfg.localPort).toBe(24000);
    expect(cfg.allowDelete).toBe(true);
    expect(cfg.scholarProviders).toEqual(['openalex', 'crossref']);
    expect(cfg.indexFulltext).toBe(true);
    expect(cfg.indexFulltextMaxChars).toBe(0); // 0 = no per-item cap
    expect(cfg.embeddingModel).toBe('text-embedding-3-large');
    expect(cfg.embedBatchSize).toBe(16);
    expect(cfg.embedBatchDelayMs).toBe(500);
  });

  it('throws on an invalid enum value', () => {
    expect(() => loadConfig({ ZOTEUS_LOCAL: 'maybe' } as unknown as NodeJS.ProcessEnv)).toThrow();
  });

  it('treats an empty ZOTERO_API_KEY as unset rather than crashing boot', () => {
    const cfg = loadConfig({ ZOTERO_API_KEY: '' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBeUndefined();
  });

  it('boots on an all-blank desktop (.mcpb) environment, keeping every default', () => {
    // A .mcpb client substitutes each user_config field the user left empty as an
    // empty-string env var, so blank must mean "use the default", never 0 or a crash.
    const cfg = loadConfig({
      ZOTERO_API_KEY: '',
      ZOTEUS_LOCAL: '',
      ZOTEUS_EMBEDDINGS: '',
      ZOTEUS_EMBEDDING_MODEL: '',
      ZOTEUS_EMBED_BATCH_SIZE: '',
      ZOTEUS_EMBED_BATCH_DELAY_MS: '   ',
      ZOTEUS_TRANSFORMERS_PATH: '',
      ZOTEUS_INDEX_FULLTEXT: '',
      ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: '',
      ZOTEUS_INDEX_MAX_ITEMS: '',
      ZOTEUS_DIST: 'mcpb',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.local).toBe('auto');
    expect(cfg.embeddings).toBe('local');
    expect(cfg.embeddingModel).toBeUndefined();
    expect(cfg.embedBatchSize).toBeUndefined();
    expect(cfg.embedBatchDelayMs).toBe(0);
    expect(cfg.transformersPath).toBeUndefined();
    expect(cfg.indexFulltext).toBe(false);
    expect(cfg.indexFulltextMaxChars).toBe(40000); // not 0, which would mean "no cap"
    expect(cfg.indexMaxItems).toBe(5000);
  });

  it('keeps every other default when its env var is blank', () => {
    const cfg = loadConfig({
      ZOTERO_LIBRARY_ID: '',
      ZOTERO_LOCAL_PORT: '',
      ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC: '',
      ZOTEUS_MCP_RATE_LIMIT_MAX: '',
      ZOTEUS_OAUTH_ACCESS_TTL: '',
      ZOTEUS_OAUTH_REFRESH_TTL: '',
      ZOTEUS_CIMD_CACHE_TTL_SEC: '',
      ZOTEUS_CIMD_MAX_BYTES: '',
      ZOTERO_LIBRARY_TYPE: '',
      ZOTEUS_INDEX_BACKEND: '',
      ZOTEUS_LOG_LEVEL: '',
      ZOTEUS_LOG_FORMAT: '',
      ZOTEUS_TRANSLATION_SERVER_URL: '',
      ZOTEUS_CONTACT_EMAIL: '',
      ZOTEUS_DATA_DIR: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.libraryId).toBeUndefined();
    expect(cfg.localPort).toBe(23119);
    expect(cfg.mcpRateLimit).toEqual({ windowMs: 60_000, max: 120 });
    expect(cfg.oauth.accessTokenTtlSec).toBe(3600);
    expect(cfg.oauth.refreshTokenTtlSec).toBe(2592000);
    expect(cfg.cimd.cacheTtlSec).toBe(3600);
    expect(cfg.cimd.maxBytes).toBe(16384);
    expect(cfg.libraryType).toBe('user');
    expect(cfg.indexBackend).toBe('auto');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.logFormat).toBe('text');
    expect(cfg.translationServerUrl).toBe('http://127.0.0.1:1969');
    expect(cfg.contactEmail).toBeUndefined();
    expect(cfg.dataDir).not.toBe(''); // blank must fall back to the OS data dir
  });

  it('still rejects a value that is set but invalid', () => {
    expect(() =>
      loadConfig({ ZOTEUS_INDEX_MAX_ITEMS: 'lots' } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      loadConfig({ ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: '-1' } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('treats empty optional string secrets as unset (no min(1) parse crash)', () => {
    expect(() =>
      loadConfig({
        ZOTEUS_OAUTH_PASSCODE: '',
        ZOTERO_OAUTH_CLIENT_KEY: '',
        ZOTERO_OAUTH_CLIENT_SECRET: '',
        ZOTEUS_OAUTH_TOKEN_SECRET: '',
      } as unknown as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe('oauth config', () => {
  const enabledEnv = {
    ZOTERO_API_KEY: 'k',
    ZOTEUS_OAUTH_ENABLED: 'true',
    ZOTEUS_PUBLIC_URL: 'https://zoteus.example.com',
    ZOTEUS_OAUTH_PASSCODE: 'a-strong-passcode',
  } as unknown as NodeJS.ProcessEnv;

  it('defaults oauth.enabled to false', () => {
    const c = loadConfig({ ZOTERO_API_KEY: 'k' } as unknown as NodeJS.ProcessEnv);
    expect(c.oauth.enabled).toBe(false);
    expect(c.oauth.allowedHosts).toEqual([]);
  });

  it('parses oauth settings when enabled', () => {
    const c = loadConfig(enabledEnv);
    expect(c.oauth.enabled).toBe(true);
    expect(c.oauth.publicUrl).toBe('https://zoteus.example.com');
    expect(c.oauth.passcode).toBe('a-strong-passcode');
    expect(c.oauth.accessTokenTtlSec).toBe(3600);
    expect(c.oauth.refreshTokenTtlSec).toBe(2592000);
  });

  it('throws when oauth enabled without public url or passcode', () => {
    expect(() =>
      loadConfig({ ZOTERO_API_KEY: 'k', ZOTEUS_OAUTH_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTEUS_PUBLIC_URL/);
    expect(() =>
      loadConfig({
        ZOTERO_API_KEY: 'k',
        ZOTEUS_OAUTH_ENABLED: 'true',
        ZOTEUS_PUBLIC_URL: 'https://x.example',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTEUS_OAUTH_PASSCODE/);
  });

  it('rejects a short (weak) passcode', () => {
    expect(() =>
      loadConfig({ ...enabledEnv, ZOTEUS_OAUTH_PASSCODE: 'hunter2' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/at least 12/);
  });

  it('strips trailing slash from public url', () => {
    const c = loadConfig({ ...enabledEnv, ZOTEUS_PUBLIC_URL: 'https://zoteus.example.com/' } as unknown as NodeJS.ProcessEnv);
    expect(c.oauth.publicUrl).toBe('https://zoteus.example.com');
  });

  it('parses ZOTEUS_ALLOWED_HOSTS into a trimmed list', () => {
    const c = loadConfig({ ...enabledEnv, ZOTEUS_ALLOWED_HOSTS: 'a.example.com, b.example.com:8443 ' } as unknown as NodeJS.ProcessEnv);
    expect(c.oauth.allowedHosts).toEqual(['a.example.com', 'b.example.com:8443']);
  });
});

describe('M13 ops config', () => {
  const base = { ZOTERO_API_KEY: 'k' };
  it('defaults logFormat=text, metricsEnabled=false, mcp rate limit on, readyz zotero on', () => {
    const c = loadConfig({ ...base });
    expect(c.logFormat).toBe('text');
    expect(c.metricsEnabled).toBe(false);
    expect(c.mcpRateLimit).toEqual({ windowMs: 60_000, max: 120 });
    expect(c.readyzCheckZotero).toBe(true);
    expect(c.allowInsecureHttp).toBe(false);
  });
  it('parses overrides', () => {
    const c = loadConfig({
      ...base,
      ZOTEUS_LOG_FORMAT: 'json',
      ZOTEUS_METRICS_ENABLED: 'true',
      ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC: '30',
      ZOTEUS_MCP_RATE_LIMIT_MAX: '0',
      ZOTEUS_READYZ_CHECK_ZOTERO: 'false',
      ZOTEUS_ALLOW_INSECURE_HTTP: '1',
    });
    expect(c.logFormat).toBe('json');
    expect(c.metricsEnabled).toBe(true);
    expect(c.mcpRateLimit).toEqual({ windowMs: 30_000, max: 0 });
    expect(c.readyzCheckZotero).toBe(false);
    expect(c.allowInsecureHttp).toBe(true);
  });
});

describe('M14 CIMD config', () => {
  const base = { ZOTERO_API_KEY: 'k' };
  it('defaults: CIMD off, 1h cache, 16KB cap, https-only redirects', () => {
    const c = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(c.cimd).toEqual({
      enabled: false,
      cacheTtlSec: 3600,
      maxBytes: 16384,
      allowedRedirectSchemes: ['https'],
      allowedHosts: [],
    });
  });
  it('parses overrides', () => {
    const c = loadConfig({
      ...base,
      ZOTEUS_CIMD_ENABLED: 'true',
      ZOTEUS_CIMD_CACHE_TTL_SEC: '600',
      ZOTEUS_CIMD_MAX_BYTES: '8192',
      ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES: 'https,http',
      ZOTEUS_CIMD_ALLOWED_HOSTS: 'claude.ai, Example.COM',
    } as NodeJS.ProcessEnv);
    expect(c.cimd.enabled).toBe(true);
    expect(c.cimd.cacheTtlSec).toBe(600);
    expect(c.cimd.maxBytes).toBe(8192);
    expect(c.cimd.allowedRedirectSchemes).toEqual(['https', 'http']);
    expect(c.cimd.allowedHosts).toEqual(['claude.ai', 'example.com']);
  });
});

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
    expect(cfg.embeddingDtype).toBe('fp32');
    expect(cfg.embedBatchSize).toBeUndefined();
    expect(cfg.embedBatchDelayMs).toBe(0);
    // Full-text indexing is opt-in: it multiplies build time and index size.
    expect(cfg.indexFulltext).toBe(false);
    expect(cfg.indexFulltextMaxChars).toBe(40000);
    // Two-stage vector search is on by default: it is what keeps a semantic query on a
    // large index from scanning every vector (#30).
    expect(cfg.indexAnn).toBe(true);
    // Accent expansion is on by default: it compensates the recall that keeping
    // diacritics in the index removed for unaccented queries.
    expect(cfg.accentExpansion).toBe(true);
    expect(cfg.indexAnnOversample).toBe(16);
    expect(cfg.indexAnnMinCandidates).toBe(500);
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
      ZOTEUS_INDEX_ANN: 'false',
      ZOTEUS_ACCENT_EXPANSION: 'false',
      ZOTEUS_INDEX_ANN_OVERSAMPLE: '32',
      ZOTEUS_INDEX_ANN_MIN_CANDIDATES: '2000',
      ZOTEUS_INDEX_FULLTEXT_CONCURRENCY: '3',
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
    expect(cfg.indexAnn).toBe(false);
    expect(cfg.accentExpansion).toBe(false);
    expect(cfg.indexAnnOversample).toBe(32);
    expect(cfg.indexAnnMinCandidates).toBe(2000);
    expect(cfg.indexFulltextConcurrency).toBe(3);
  });

  it('leaves the full-text concurrency unset unless it is asked for, so the backend picks', () => {
    // Unset is not "4": the default depends on which Zotero API is serving the build, and
    // only an explicit value overrides that choice (#39).
    expect(loadConfig({} as unknown as NodeJS.ProcessEnv).indexFulltextConcurrency).toBeUndefined();
    const bad = loadConfig({ ZOTEUS_INDEX_FULLTEXT_CONCURRENCY: '0' } as unknown as NodeJS.ProcessEnv);
    expect(bad.indexFulltextConcurrency).toBeUndefined();
    expect(bad.warnings).toEqual(['ZOTEUS_INDEX_FULLTEXT_CONCURRENCY="0" is not usable, ignoring it']);
  });

  it('falls back on an invalid enum value, and says which', () => {
    const cfg = loadConfig({ ZOTEUS_LOCAL: 'maybe' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.local).toBe('auto');
    expect(cfg.warnings).toEqual(['ZOTEUS_LOCAL="maybe" is not usable, using "auto"']);
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
    expect(cfg.warnings).toEqual([]);
  });

  it('keeps the full-text cap at its default when the field is blank and full text is ON', () => {
    // Claude Desktop's number input will not display a 0 the user types, so the box looks
    // blank and the setting looks rejected (#38). It is not: 0 persists and does mean "no
    // cap". Blank must keep meaning "the default", though, and this pins that it does even
    // with full-text indexing turned on, the one combination where reading blank as "no
    // cap" would have been tempting. It would also have uncapped every existing install
    // that turned full text on and never touched this dial, turning a documented 40000
    // into an unbounded crawl of every book in the library.
    const cfg = loadConfig({
      ZOTEUS_INDEX_FULLTEXT: 'true',
      ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.indexFulltext).toBe(true);
    expect(cfg.indexFulltextMaxChars).toBe(40000);
    expect(cfg.warnings).toEqual([]);

    // ...and 0, whatever the box shows, still means no cap.
    const uncapped = loadConfig({
      ZOTEUS_INDEX_FULLTEXT: 'true',
      ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: '0',
    } as unknown as NodeJS.ProcessEnv);
    expect(uncapped.indexFulltextMaxChars).toBe(0);
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

  it('boots on the environment a desktop host really passes for empty fields', () => {
    // The crash in #18, copied from /proc/<pid>/environ of the running extension on Claude
    // Desktop 1.37937. A user_config field with no manifest default that the user left
    // empty is not substituted at all: the reference is passed through verbatim. The four
    // numeric ones reached z.coerce.number() as NaN and threw a ZodError out of loadConfig,
    // before the logger exists, so the process died at ~1s having logged nothing.
    const cfg = loadConfig({
      ZOTERO_API_KEY: 'abc',
      ZOTEUS_LOCAL: 'auto',
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_EMBEDDING_MODEL: '${user_config.embedding_model}',
      ZOTEUS_EMBEDDING_DTYPE: '${user_config.embedding_dtype}',
      ZOTEUS_EMBED_BATCH_SIZE: '${user_config.embed_batch_size}',
      ZOTEUS_EMBED_BATCH_DELAY_MS: '${user_config.embed_batch_delay_ms}',
      ZOTEUS_TRANSFORMERS_PATH: '${user_config.transformers_path}',
      ZOTEUS_INDEX_FULLTEXT: 'false',
      ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: '${user_config.index_fulltext_max_chars}',
      ZOTEUS_INDEX_MAX_ITEMS: '${user_config.index_max_items}',
      ZOTEUS_DIST: 'mcpb',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('abc');
    expect(cfg.embeddingModel).toBeUndefined();
    expect(cfg.embedBatchSize).toBeUndefined();
    expect(cfg.embedBatchDelayMs).toBe(0);
    expect(cfg.transformersPath).toBeUndefined();
    expect(cfg.indexFulltextMaxChars).toBe(40000);
    expect(cfg.indexMaxItems).toBe(5000);
    // The host is saying it has no value, so this is the normal path, not a warning.
    expect(cfg.warnings).toEqual([]);
  });

  it('survives a host that stringifies an absent value instead', () => {
    // Not observed in #18, where the reference came through unresolved, but it is what a
    // host doing String(undefined) would send and it costs nothing to accept.
    for (const marker of ['undefined', 'null', 'NaN']) {
      const cfg = loadConfig({
        ZOTEUS_INDEX_MAX_ITEMS: marker,
        ZOTEUS_EMBEDDING_MODEL: marker,
      } as unknown as NodeJS.ProcessEnv);
      expect(cfg.indexMaxItems).toBe(5000);
      expect(cfg.embeddingModel).toBeUndefined();
      expect(cfg.warnings).toEqual([]);
    }
  });

  it('reports a value that is set but invalid, instead of refusing to start', () => {
    // A tuning knob is never worth a dead server (#18), so a bad one is named on stderr
    // and replaced by the default it would have had if it were absent.
    const cfg = loadConfig({
      ZOTEUS_INDEX_MAX_ITEMS: 'lots',
      ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: '-1',
      ZOTEUS_CONTACT_EMAIL: 'not-an-address',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.indexMaxItems).toBe(5000);
    expect(cfg.indexFulltextMaxChars).toBe(40000);
    expect(cfg.contactEmail).toBeUndefined();
    expect(cfg.warnings).toEqual([
      'ZOTEUS_INDEX_FULLTEXT_MAX_CHARS="-1" is not usable, using 40000',
      'ZOTEUS_INDEX_MAX_ITEMS="lots" is not usable, using 5000',
      'ZOTEUS_CONTACT_EMAIL="not-an-address" is not usable, ignoring it',
    ]);
  });

  it('still refuses to start when a setting that has no default is missing', () => {
    expect(() =>
      loadConfig({
        ZOTEUS_OAUTH_ENABLED: 'true',
        ZOTEUS_OAUTH_PASSCODE: 'a-long-enough-passcode',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTEUS_PUBLIC_URL is required/);
  });

  it('says a required setting was rejected rather than that it is missing', () => {
    // The operator plainly set it, so "is required" would send them looking for the wrong
    // problem. Throwing also discards the warnings, so the refusal carries them itself.
    expect(() =>
      loadConfig({
        ZOTEUS_OAUTH_ENABLED: 'true',
        ZOTEUS_PUBLIC_URL: 'zoteus.example.com',
        ZOTEUS_OAUTH_PASSCODE: 'a-long-enough-passcode',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTEUS_PUBLIC_URL="zoteus.example.com" is not usable: it must be an absolute URL/);
  });

  it('never turns an unset marker into the data directory', () => {
    // loadConfig maps the marker to undefined, and the fallback then re-read the raw
    // environment and handed it straight back, so the server made a directory named after
    // the reference in whatever the working directory happened to be.
    for (const marker of ['${user_config.data_dir}', 'undefined', 'null', '   ', '']) {
      const cfg = loadConfig({ ZOTEUS_DATA_DIR: marker } as unknown as NodeJS.ProcessEnv);
      expect(cfg.dataDir).not.toBe(marker);
      expect(cfg.dataDir.includes('${')).toBe(false);
      expect(cfg.dataDir.trim()).not.toBe('');
    }
    expect(loadConfig({ ZOTEUS_DATA_DIR: '/tmp/zoteus-data' } as unknown as NodeJS.ProcessEnv).dataDir).toBe(
      '/tmp/zoteus-data',
    );
  });

  it('refuses a scope it would otherwise have to guess', () => {
    // Falling back here would silently point reads, and writes, at a different library.
    expect(() =>
      loadConfig({ ZOTERO_LIBRARY_TYPE: 'Group', ZOTERO_LIBRARY_ID: '123' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTERO_LIBRARY_TYPE="Group" is not usable/);
    expect(() =>
      loadConfig({ ZOTERO_LIBRARY_ID: 'g123456' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTERO_LIBRARY_ID="g123456" is not usable/);
  });

  it('refuses a security model it would otherwise have to guess', () => {
    const base = {
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_PUBLIC_URL: 'https://zoteus.example.com',
      ZOTERO_OAUTH_CLIENT_KEY: 'ck',
      ZOTERO_OAUTH_CLIENT_SECRET: 'cs',
      ZOTEUS_OAUTH_PASSCODE: 'a-long-enough-passcode',
    };
    // A capitalised mode used to refuse. Falling back to passcode would serve every client
    // from the operator's own Zotero key instead of each user's own login.
    expect(() =>
      loadConfig({ ...base, ZOTEUS_OAUTH_MODE: 'Zotero' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTEUS_OAUTH_MODE="Zotero" is not usable/);
    // Falling back to memory would skip the ZOTEUS_OAUTH_TOKEN_SECRET check that file
    // storage exists to enforce.
    expect(() =>
      loadConfig({ ...base, ZOTEUS_OAUTH_STORE: 'File' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTEUS_OAUTH_STORE="File" is not usable/);
    // Both are knobs again when OAuth is off, because then they choose nothing.
    expect(loadConfig({ ZOTEUS_OAUTH_MODE: 'Zotero' } as unknown as NodeJS.ProcessEnv).oauth.mode).toBe(
      'passcode',
    );
  });

  it('refuses an allowlist that is a reference nothing expanded', () => {
    // An empty CIMD host list means "any public host", so mapping an unexpanded reference
    // to empty would turn a restriction into none. docker --env-file does no interpolation.
    expect(() =>
      loadConfig({
        ZOTEUS_CIMD_ENABLED: 'true',
        ZOTEUS_CIMD_ALLOWED_HOSTS: '${CIMD_HOSTS}',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ZOTEUS_CIMD_ALLOWED_HOSTS.*never expanded/);
    // Blank is how "no restriction" is spelled on purpose, and stays legal.
    expect(
      loadConfig({ ZOTEUS_CIMD_ENABLED: 'true', ZOTEUS_CIMD_ALLOWED_HOSTS: '' } as unknown as NodeJS.ProcessEnv)
        .cimd.allowedHosts,
    ).toEqual([]);
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

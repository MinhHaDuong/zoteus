import { z } from 'zod';
import { defaultDataDir } from './lib/paths.js';
import { DEFAULT_FULLTEXT_MAX_CHARS } from './features/search/fulltext-source.js';
import { DEFAULT_INDEX_MAX_ITEMS } from './features/search/limits.js';

export interface ZoteusConfig {
  apiKey?: string;
  /** Pre-provisioned Zotero 10+ desktop local-API key (skips the grant dialog). */
  localApiKey?: string;
  libraryId?: number;
  libraryType: 'user' | 'group';
  local: 'auto' | 'on' | 'off';
  localPort: number;
  translationServerUrl: string;
  embeddings: 'local' | 'openai' | 'gemini' | 'off';
  /** Model for the active API embedder (unset = that provider's own default). */
  embeddingModel?: string;
  /** Passages per embedding call (unset = DEFAULT_EMBED_BATCH_SIZE where one is batched). */
  embedBatchSize?: number;
  /** Pause between embedding batches in ms; 0 only yields to the event loop. */
  embedBatchDelayMs: number;
  /** Where to resolve @huggingface/transformers from when the install cannot see it itself. */
  transformersPath?: string;
  /** Index attachment full text (PDF bodies) alongside metadata. Opt-in: it is costly. */
  indexFulltext: boolean;
  /** Cap on indexed full-text characters per item (0 = no cap). */
  indexFulltextMaxChars: number;
  /** Cap on items per index build. Raise it for libraries larger than the default. */
  indexMaxItems: number;
  /**
   * Where the search index is stored: `sqlite` (node:sqlite, Node 22.13+), `memory` (the
   * legacy JSON file), or `auto` to take SQLite whenever the runtime provides it.
   */
  indexBackend: 'auto' | 'sqlite' | 'memory';
  scholarProviders: string[];
  dataDir: string;
  contactEmail?: string;
  allowDelete: boolean;
  readOnly: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'text' | 'json';
  /** Daily check against GitHub releases for a newer version (surfaced via zotero_whoami). */
  updateCheck: boolean;
  /** Distribution channel marker (the .dxt manifest sets "dxt"); tailors the update notice. */
  dist?: string;
  allowInsecureHttp: boolean;
  metricsEnabled: boolean;
  readyzCheckZotero: boolean;
  mcpRateLimit: { windowMs: number; max: number };
  oauth: {
    enabled: boolean;
    publicUrl?: string;
    passcode?: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    allowedHosts: string[];
    mode: 'passcode' | 'zotero';
    zoteroClientKey?: string;
    zoteroClientSecret?: string;
    store: 'memory' | 'file';
    tokenSecret?: string;
  };
  cimd: {
    enabled: boolean;
    cacheTtlSec: number;
    maxBytes: number;
    allowedRedirectSchemes: string[];
    allowedHosts: string[];
  };
  /**
   * Settings that could not be used and fell back to their default. Reported once the
   * logger exists, because `loadConfig` runs before it.
   */
  warnings: string[];
}

/** Minimum length for the consent passcode (defense-in-depth alongside /consent throttling). */
export const MIN_PASSCODE_LENGTH = 12;

/**
 * Values that mean "the host had nothing to put here", rather than a setting.
 *
 * A desktop-extension (`.mcpb`) client substitutes every env entry its manifest declares,
 * including the ones whose `user_config` field the user left empty. Where that field also
 * has no `default` in the manifest, Claude Desktop 1.37937 does not substitute anything at
 * all: it passes the reference through verbatim, so the server is handed the literal text
 * `${user_config.embed_batch_size}`. That is #18, read out of `/proc/<pid>/environ` of the
 * running extension rather than inferred. A blank string is the other form, which is what
 * a bare `KEY=` line in a .env file produces and what earlier hosts sent for an empty
 * field; `undefined` and `null` are what a host that stringifies an absent value would
 * send, and are covered because this is the third round of guessing which one arrives.
 * None of them is a value, so none reaches a schema: they become `undefined` and the
 * schema's own `.default()`/`.optional()` applies. Without this, `z.coerce.number()` reads
 * '' as 0 and an unresolved reference as NaN, the first silently replacing a default (no
 * full-text cap, no rate limit) and the second stopping the server from starting.
 */
const UNSET_MARKER = /^(?:undefined|null|nan|\$\{.*\})$/i;

const isUnset = (v: unknown): boolean =>
  typeof v === 'string' && (v.trim() === '' || UNSET_MARKER.test(v.trim()));

/** An optional flag. Absent, or blank in the sense above, keeps `def`. */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v.toLowerCase() === 'true' || v === '1'));

/**
 * What a schema yields for a variable that is not set: its `.default()`, or `undefined`
 * where it is `.optional()`. Asking the schema keeps that answer in one place instead of
 * restating every default beside itself.
 */
const whenAbsent = <T extends z.ZodTypeAny>(schema: T): z.output<T> => {
  const parsed = schema.safeParse(undefined);
  return (parsed.success ? parsed.data : undefined) as z.output<T>;
};

/**
 * One setting, and the promise that no single one of them can stop the server from
 * starting. A value that is present but unusable (a host marker this version does not
 * recognise, a typo, a negative cap) is collected in `warnings` and replaced by what the
 * variable's absence would have given.
 *
 * `loadConfig` runs before the logger exists, so a `ZodError` here is a `FATAL` line on
 * stderr and a dead process: exactly how #18 crashed, and a mistyped tuning knob is not
 * worth that. It is the reasoning of #20 (a damaged index stopped being fatal) applied to
 * configuration. The settings that have no safe default, the OAuth credentials, are still
 * checked below, after parsing, where the failure can name what is missing.
 */
const knob = <T extends z.ZodTypeAny>(key: string, schema: T, warnings: string[]) =>
  z.preprocess((v) => (isUnset(v) ? undefined : v), schema).catch((ctx) => {
    const fallback = whenAbsent(schema);
    warnings.push(
      `${key}=${JSON.stringify(ctx.input)} is not usable, ` +
        (fallback === undefined ? 'ignoring it' : `using ${JSON.stringify(fallback)}`),
    );
    return fallback;
  });

/**
 * Wraps every field in `knob`, so the key a warning names is the key that failed and the
 * two cannot drift apart. The cast restates the wrapper's output type, which is what
 * `z.object` reads and which `knob` leaves exactly as the wrapped schema's.
 */
const tolerant = <S extends z.ZodRawShape>(fields: S, warnings: string[]): S =>
  Object.fromEntries(
    Object.entries(fields).map(([key, schema]) => [key, knob(key, schema, warnings)]),
  ) as unknown as S;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ZoteusConfig {
  const warnings: string[] = [];
  const schema = z.object(
    tolerant(
      {
        ZOTERO_API_KEY: z.string().min(1).optional(),
        ZOTEUS_LOCAL_API_KEY: z.string().min(1).optional(),
        ZOTERO_LIBRARY_ID: z.coerce.number().int().positive().optional(),
        ZOTERO_LIBRARY_TYPE: z.enum(['user', 'group']).default('user'),
        ZOTEUS_LOCAL: z.enum(['auto', 'on', 'off']).default('auto'),
        ZOTERO_LOCAL_PORT: z.coerce.number().int().positive().default(23119),
        ZOTEUS_TRANSLATION_SERVER_URL: z.string().url().default('http://127.0.0.1:1969'),
        ZOTEUS_EMBEDDINGS: z.enum(['local', 'openai', 'gemini', 'off']).default('local'),
        ZOTEUS_EMBEDDING_MODEL: z.string().min(1).optional(),
        ZOTEUS_EMBED_BATCH_SIZE: z.coerce.number().int().positive().optional(),
        ZOTEUS_EMBED_BATCH_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
        ZOTEUS_TRANSFORMERS_PATH: z.string().min(1).optional(),
        ZOTEUS_INDEX_FULLTEXT: bool(false),
        ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: z.coerce
          .number()
          .int()
          .nonnegative()
          .default(DEFAULT_FULLTEXT_MAX_CHARS),
        ZOTEUS_INDEX_MAX_ITEMS: z.coerce.number().int().positive().default(DEFAULT_INDEX_MAX_ITEMS),
        ZOTEUS_INDEX_BACKEND: z.enum(['auto', 'sqlite', 'memory']).default('auto'),
        ZOTEUS_SCHOLAR_PROVIDERS: z.string().default('openalex'),
        ZOTEUS_DATA_DIR: z.string().min(1).optional(),
        ZOTEUS_CONTACT_EMAIL: z.string().email().optional(),
        ZOTEUS_ALLOW_DELETE: bool(false),
        ZOTEUS_READ_ONLY: bool(false),
        ZOTEUS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        ZOTEUS_LOG_FORMAT: z.enum(['text', 'json']).default('text'),
        ZOTEUS_UPDATE_CHECK: bool(true),
        ZOTEUS_DIST: z.string().min(1).optional(),
        ZOTEUS_ALLOW_INSECURE_HTTP: bool(false),
        ZOTEUS_METRICS_ENABLED: bool(false),
        ZOTEUS_READYZ_CHECK_ZOTERO: bool(true),
        ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().nonnegative().default(60),
        ZOTEUS_MCP_RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(120),
        ZOTEUS_OAUTH_ENABLED: bool(false),
        ZOTEUS_PUBLIC_URL: z.string().url().optional(),
        ZOTEUS_OAUTH_PASSCODE: z.string().min(1).optional(),
        ZOTEUS_OAUTH_ACCESS_TTL: z.coerce.number().int().positive().default(3600),
        ZOTEUS_OAUTH_REFRESH_TTL: z.coerce.number().int().positive().default(2592000),
        ZOTEUS_ALLOWED_HOSTS: z.string().optional(),
        ZOTEUS_OAUTH_MODE: z.enum(['passcode', 'zotero']).default('passcode'),
        ZOTERO_OAUTH_CLIENT_KEY: z.string().min(1).optional(),
        ZOTERO_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
        ZOTEUS_OAUTH_STORE: z.enum(['memory', 'file']).default('memory'),
        ZOTEUS_OAUTH_TOKEN_SECRET: z.string().min(1).optional(),
        ZOTEUS_CIMD_ENABLED: bool(false),
        ZOTEUS_CIMD_CACHE_TTL_SEC: z.coerce.number().int().nonnegative().default(3600),
        ZOTEUS_CIMD_MAX_BYTES: z.coerce.number().int().positive().default(16384),
        ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES: z.string().default('https'),
        ZOTEUS_CIMD_ALLOWED_HOSTS: z.string().default(''),
      },
      warnings,
    ),
  );

  const parsed = schema.parse(env);

  const oauthEnabled = parsed.ZOTEUS_OAUTH_ENABLED;
  const publicUrl = parsed.ZOTEUS_PUBLIC_URL?.replace(/\/+$/, '');
  const mode = parsed.ZOTEUS_OAUTH_MODE;
  const store = parsed.ZOTEUS_OAUTH_STORE;
  if (oauthEnabled) {
    if (!publicUrl) throw new Error('ZOTEUS_PUBLIC_URL is required when ZOTEUS_OAUTH_ENABLED=true');
    if (mode === 'passcode') {
      if (!parsed.ZOTEUS_OAUTH_PASSCODE) {
        throw new Error('ZOTEUS_OAUTH_PASSCODE is required when ZOTEUS_OAUTH_ENABLED=true (passcode mode)');
      }
      if (parsed.ZOTEUS_OAUTH_PASSCODE.length < MIN_PASSCODE_LENGTH) {
        throw new Error(
          `ZOTEUS_OAUTH_PASSCODE must be at least ${MIN_PASSCODE_LENGTH} characters (generate one with: openssl rand -base64 24)`,
        );
      }
    } else {
      // zotero mode: per-user Zotero login replaces the shared passcode
      if (!parsed.ZOTERO_OAUTH_CLIENT_KEY || !parsed.ZOTERO_OAUTH_CLIENT_SECRET) {
        throw new Error(
          'ZOTERO_OAUTH_CLIENT_KEY and ZOTERO_OAUTH_CLIENT_SECRET are required when ZOTEUS_OAUTH_MODE=zotero (register an app at https://www.zotero.org/oauth/apps)',
        );
      }
    }
    if (store === 'file' && !parsed.ZOTEUS_OAUTH_TOKEN_SECRET) {
      throw new Error(
        'ZOTEUS_OAUTH_TOKEN_SECRET is required when ZOTEUS_OAUTH_STORE=file (used to encrypt stored Zotero keys at rest; generate one with: openssl rand -base64 32)',
      );
    }
  }
  const allowedHosts = (parsed.ZOTEUS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    apiKey: parsed.ZOTERO_API_KEY,
    localApiKey: parsed.ZOTEUS_LOCAL_API_KEY,
    libraryId: parsed.ZOTERO_LIBRARY_ID,
    libraryType: parsed.ZOTERO_LIBRARY_TYPE,
    local: parsed.ZOTEUS_LOCAL,
    localPort: parsed.ZOTERO_LOCAL_PORT,
    translationServerUrl: parsed.ZOTEUS_TRANSLATION_SERVER_URL,
    embeddings: parsed.ZOTEUS_EMBEDDINGS,
    embeddingModel: parsed.ZOTEUS_EMBEDDING_MODEL?.trim() || undefined,
    embedBatchSize: parsed.ZOTEUS_EMBED_BATCH_SIZE,
    embedBatchDelayMs: parsed.ZOTEUS_EMBED_BATCH_DELAY_MS,
    transformersPath: parsed.ZOTEUS_TRANSFORMERS_PATH?.trim() || undefined,
    indexFulltext: parsed.ZOTEUS_INDEX_FULLTEXT,
    indexFulltextMaxChars: parsed.ZOTEUS_INDEX_FULLTEXT_MAX_CHARS,
    indexMaxItems: parsed.ZOTEUS_INDEX_MAX_ITEMS,
    indexBackend: parsed.ZOTEUS_INDEX_BACKEND,
    scholarProviders: parsed.ZOTEUS_SCHOLAR_PROVIDERS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataDir: parsed.ZOTEUS_DATA_DIR ?? defaultDataDir(env),
    contactEmail: parsed.ZOTEUS_CONTACT_EMAIL,
    allowDelete: parsed.ZOTEUS_ALLOW_DELETE,
    readOnly: parsed.ZOTEUS_READ_ONLY,
    logLevel: parsed.ZOTEUS_LOG_LEVEL,
    logFormat: parsed.ZOTEUS_LOG_FORMAT,
    updateCheck: parsed.ZOTEUS_UPDATE_CHECK,
    dist: parsed.ZOTEUS_DIST,
    allowInsecureHttp: parsed.ZOTEUS_ALLOW_INSECURE_HTTP,
    metricsEnabled: parsed.ZOTEUS_METRICS_ENABLED,
    readyzCheckZotero: parsed.ZOTEUS_READYZ_CHECK_ZOTERO,
    mcpRateLimit: {
      windowMs: parsed.ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC * 1000,
      max: parsed.ZOTEUS_MCP_RATE_LIMIT_MAX,
    },
    oauth: {
      enabled: oauthEnabled,
      publicUrl,
      passcode: parsed.ZOTEUS_OAUTH_PASSCODE,
      accessTokenTtlSec: parsed.ZOTEUS_OAUTH_ACCESS_TTL,
      refreshTokenTtlSec: parsed.ZOTEUS_OAUTH_REFRESH_TTL,
      allowedHosts,
      mode,
      zoteroClientKey: parsed.ZOTERO_OAUTH_CLIENT_KEY,
      zoteroClientSecret: parsed.ZOTERO_OAUTH_CLIENT_SECRET,
      store,
      tokenSecret: parsed.ZOTEUS_OAUTH_TOKEN_SECRET,
    },
    cimd: {
      enabled: parsed.ZOTEUS_CIMD_ENABLED,
      cacheTtlSec: parsed.ZOTEUS_CIMD_CACHE_TTL_SEC,
      maxBytes: parsed.ZOTEUS_CIMD_MAX_BYTES,
      allowedRedirectSchemes: parsed.ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      allowedHosts: parsed.ZOTEUS_CIMD_ALLOWED_HOSTS.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    },
    warnings,
  };
}

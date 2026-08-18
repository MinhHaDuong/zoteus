import { z } from 'zod';
import { defaultDataDir } from './lib/paths.js';

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
  scholarProviders: string[];
  dataDir: string;
  contactEmail?: string;
  allowDelete: boolean;
  readOnly: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'text' | 'json';
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
}

/** Minimum length for the consent passcode (defense-in-depth alongside /consent throttling). */
export const MIN_PASSCODE_LENGTH = 12;

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v.toLowerCase() === 'true' || v === '1'));

/**
 * A string env var that is optional but, when present, must be non-empty.
 * Treats an empty string (a bare `KEY=` line in a .env file) as unset rather
 * than a `min(1)` violation, so empty entries don't crash boot. Where the value
 * is actually required (e.g. zotero-mode OAuth creds), the cross-field checks
 * below surface a clear error instead of a cryptic parse failure.
 */
const optionalNonEmpty = () =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ZoteusConfig {
  const schema = z.object({
    ZOTERO_API_KEY: optionalNonEmpty(),
    ZOTEUS_LOCAL_API_KEY: optionalNonEmpty(),
    ZOTERO_LIBRARY_ID: z.coerce.number().int().positive().optional(),
    ZOTERO_LIBRARY_TYPE: z.enum(['user', 'group']).default('user'),
    ZOTEUS_LOCAL: z.enum(['auto', 'on', 'off']).default('auto'),
    ZOTERO_LOCAL_PORT: z.coerce.number().int().positive().default(23119),
    ZOTEUS_TRANSLATION_SERVER_URL: z.string().url().default('http://127.0.0.1:1969'),
    ZOTEUS_EMBEDDINGS: z.enum(['local', 'openai', 'gemini', 'off']).default('local'),
    ZOTEUS_SCHOLAR_PROVIDERS: z.string().default('openalex'),
    ZOTEUS_DATA_DIR: z.string().optional(),
    ZOTEUS_CONTACT_EMAIL: z.string().email().optional(),
    ZOTEUS_ALLOW_DELETE: bool(false),
    ZOTEUS_READ_ONLY: bool(false),
    ZOTEUS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    ZOTEUS_LOG_FORMAT: z.enum(['text', 'json']).default('text'),
    ZOTEUS_ALLOW_INSECURE_HTTP: bool(false),
    ZOTEUS_METRICS_ENABLED: bool(false),
    ZOTEUS_READYZ_CHECK_ZOTERO: bool(true),
    ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().nonnegative().default(60),
    ZOTEUS_MCP_RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(120),
    ZOTEUS_OAUTH_ENABLED: bool(false),
    ZOTEUS_PUBLIC_URL: z.string().url().optional(),
    ZOTEUS_OAUTH_PASSCODE: optionalNonEmpty(),
    ZOTEUS_OAUTH_ACCESS_TTL: z.coerce.number().int().positive().default(3600),
    ZOTEUS_OAUTH_REFRESH_TTL: z.coerce.number().int().positive().default(2592000),
    ZOTEUS_ALLOWED_HOSTS: z.string().optional(),
    ZOTEUS_OAUTH_MODE: z.enum(['passcode', 'zotero']).default('passcode'),
    ZOTERO_OAUTH_CLIENT_KEY: optionalNonEmpty(),
    ZOTERO_OAUTH_CLIENT_SECRET: optionalNonEmpty(),
    ZOTEUS_OAUTH_STORE: z.enum(['memory', 'file']).default('memory'),
    ZOTEUS_OAUTH_TOKEN_SECRET: optionalNonEmpty(),
    ZOTEUS_CIMD_ENABLED: bool(false),
    ZOTEUS_CIMD_CACHE_TTL_SEC: z.coerce.number().int().nonnegative().default(3600),
    ZOTEUS_CIMD_MAX_BYTES: z.coerce.number().int().positive().default(16384),
    ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES: z.string().default('https'),
    ZOTEUS_CIMD_ALLOWED_HOSTS: z.string().default(''),
  });

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
    scholarProviders: parsed.ZOTEUS_SCHOLAR_PROVIDERS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataDir: parsed.ZOTEUS_DATA_DIR ?? defaultDataDir(env),
    contactEmail: parsed.ZOTEUS_CONTACT_EMAIL,
    allowDelete: parsed.ZOTEUS_ALLOW_DELETE,
    readOnly: parsed.ZOTEUS_READ_ONLY,
    logLevel: parsed.ZOTEUS_LOG_LEVEL,
    logFormat: parsed.ZOTEUS_LOG_FORMAT,
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
  };
}

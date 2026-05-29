import { z } from 'zod';
import { defaultDataDir } from './lib/paths.js';

export interface ZoteusConfig {
  apiKey?: string;
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
  oauth: {
    enabled: boolean;
    publicUrl?: string;
    passcode?: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ZoteusConfig {
  const schema = z.object({
    ZOTERO_API_KEY: z.string().min(1).optional(),
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
    ZOTEUS_OAUTH_ENABLED: bool(false),
    ZOTEUS_PUBLIC_URL: z.string().url().optional(),
    ZOTEUS_OAUTH_PASSCODE: z.string().min(1).optional(),
    ZOTEUS_OAUTH_ACCESS_TTL: z.coerce.number().int().positive().default(3600),
    ZOTEUS_OAUTH_REFRESH_TTL: z.coerce.number().int().positive().default(2592000),
    ZOTEUS_ALLOWED_HOSTS: z.string().optional(),
  });

  const parsed = schema.parse(env);

  const oauthEnabled = parsed.ZOTEUS_OAUTH_ENABLED;
  const publicUrl = parsed.ZOTEUS_PUBLIC_URL?.replace(/\/+$/, '');
  if (oauthEnabled) {
    if (!publicUrl) throw new Error('ZOTEUS_PUBLIC_URL is required when ZOTEUS_OAUTH_ENABLED=true');
    if (!parsed.ZOTEUS_OAUTH_PASSCODE) throw new Error('ZOTEUS_OAUTH_PASSCODE is required when ZOTEUS_OAUTH_ENABLED=true');
    if (parsed.ZOTEUS_OAUTH_PASSCODE.length < MIN_PASSCODE_LENGTH) {
      throw new Error(
        `ZOTEUS_OAUTH_PASSCODE must be at least ${MIN_PASSCODE_LENGTH} characters (generate one with: openssl rand -base64 24)`,
      );
    }
  }
  const allowedHosts = (parsed.ZOTEUS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    apiKey: parsed.ZOTERO_API_KEY,
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
    oauth: {
      enabled: oauthEnabled,
      publicUrl,
      passcode: parsed.ZOTEUS_OAUTH_PASSCODE,
      accessTokenTtlSec: parsed.ZOTEUS_OAUTH_ACCESS_TTL,
      refreshTokenTtlSec: parsed.ZOTEUS_OAUTH_REFRESH_TTL,
      allowedHosts,
    },
  };
}

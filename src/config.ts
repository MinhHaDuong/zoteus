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
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

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
    ZOTEUS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  });

  const parsed = schema.parse(env);

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
    logLevel: parsed.ZOTEUS_LOG_LEVEL,
  };
}

# Zoteus Foundation (M0–M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working, Inspector-verifiable, read-only Zotero MCP server that connects to both the cloud Web API v3 and the Zotero desktop local API, with a capability probe and four read tools (`zotero_whoami`, `zotero_search_items`, `zotero_get_item`, `zotero_schema`) plus two resources.

**Architecture:** A single TypeScript (Node 18+, ESM/NodeNext) package. A `RateLimitedFetcher` centralizes concurrency + Zotero rate-limit/backoff handling. `WebApiClient` and `LocalApiClient` wrap the cloud and desktop APIs. A `LibraryRouter` chooses local-vs-cloud per read using a startup capability probe. Tools are plain `ToolDefinition` objects registered onto an `McpServer` through a thin adapter, so the same definitions can later drive code-execution wrappers and Tool Search.

**Tech Stack:** TypeScript 5, `@modelcontextprotocol/sdk@^1.29`, `zod@^3.25`, Vitest, ESLint + Prettier, native `fetch`. Distribution via `npx` (stdio transport).

---

## Verified API facts (do not deviate)

- SDK import paths (NodeNext): `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer`, `ResourceTemplate`), `@modelcontextprotocol/sdk/server/stdio.js` (`StdioServerTransport`), `@modelcontextprotocol/sdk/inMemory.js` (`InMemoryTransport`), `@modelcontextprotocol/sdk/client/index.js` (`Client`).
- `new McpServer({ name, version }, { capabilities, instructions })`.
- `server.registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations? }, cb)` where `inputSchema`/`outputSchema` are **Zod raw shapes** (e.g. `{ q: z.string() }`), NOT `z.object(...)`. `cb(args, extra)` returns `{ content: [...], structuredContent?, isError? }`.
- `server.registerResource(name, uriOrTemplate, config, cb)`; for templates use `new ResourceTemplate("zotero://...{var}", { list: undefined })`.
- `InMemoryTransport.createLinkedPair()` returns `[clientTransport, serverTransport]`.
- Client: `new Client({ name, version })`, `await client.connect(transport)`, `await client.listTools()`, `await client.callTool({ name, arguments })`, `await client.readResource({ uri })`.
- Relative TS imports MUST end in `.js` (NodeNext).
- Real test library (for e2e): userID `19552201`, ~138 top-level / 838 total items, 18 collections, library version ~2114. The API key lives ONLY in the git-ignored `.env` as `ZOTERO_API_KEY`.
- Zotero conventions baked into clients: header `Zotero-API-Version: 3`; auth header `Zotero-API-Key`; honor `Backoff` (every response) and `Retry-After` (429/503), both in seconds; pagination via `Total-Results` header + `limit`/`start`; cloud base `https://api.zotero.org`; local base `http://127.0.0.1:23119/api`, local library is `users/0`.

---

## File structure (created by this plan)

```
zoteus/
├── package.json  tsconfig.json  vitest.config.ts  .eslintrc.json  .prettierrc  .editorconfig
├── src/
│   ├── index.ts                 # CLI entry (shebang): load config → build server → connect stdio
│   ├── server.ts                # buildServer(config): wires clients/router/schema/tools/resources
│   ├── config.ts                # loadConfig(env) → ZoteusConfig (zod-validated)
│   ├── lib/
│   │   ├── logger.ts            # stderr-only logger
│   │   ├── semaphore.ts         # concurrency limiter
│   │   └── paths.ts             # default data dir
│   ├── api/
│   │   ├── errors.ts            # ZoteroApiError + actionableMessage()
│   │   ├── http.ts              # RateLimitedFetcher (concurrency + backoff + retry)
│   │   ├── web-client.ts        # WebApiClient (cloud api.zotero.org v3, reads)
│   │   └── local-client.ts      # LocalApiClient (localhost:23119/api, reads)
│   ├── router/
│   │   ├── capabilities.ts      # probeCapabilities()
│   │   └── library-router.ts    # LibraryRouter (read routing)
│   ├── schema/
│   │   └── schema-service.ts    # SchemaService (fetch + cache /schema)
│   ├── registry/
│   │   └── registry.ts          # ToolDefinition, ToolContext, registerAllTools()
│   ├── tools/
│   │   ├── index.ts             # tools[] array
│   │   ├── whoami.ts  search-items.ts  get-item.ts  schema.ts
│   ├── resources/
│   │   └── index.ts             # registerResources()
│   └── transports/
│       └── stdio.ts             # startStdio()
└── tests/
    ├── lib/semaphore.test.ts
    ├── config.test.ts
    ├── api/errors.test.ts  api/http.test.ts  api/web-client.test.ts  api/local-client.test.ts
    ├── router/capabilities.test.ts  router/library-router.test.ts
    ├── schema/schema-service.test.ts
    ├── integration/server.test.ts
    └── e2e/live.test.ts          # opt-in (skipped without ZOTERO_API_KEY)
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.json`, `.prettierrc`, `.editorconfig`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@oscardvs/zoteus",
  "version": "0.1.0",
  "description": "The everything Zotero MCP server — complete Zotero Web API v3 + desktop local API for Claude and any MCP client.",
  "keywords": ["zotero", "mcp", "model-context-protocol", "mcp-server", "claude", "citations", "bibliography", "reference-manager", "zotero-api"],
  "type": "module",
  "license": "MIT",
  "author": "Oscar Devos",
  "homepage": "https://github.com/oscardvs/zoteus",
  "repository": { "type": "git", "url": "git+https://github.com/oscardvs/zoteus.git" },
  "bin": { "zoteus": "dist/index.js" },
  "main": "dist/index.js",
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . --ext .ts",
    "format": "prettier --write .",
    "typecheck": "tsc --noEmit",
    "inspector": "npx @modelcontextprotocol/inspector npx tsx src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@typescript-eslint/eslint-plugin": "^8.18.0",
    "@typescript-eslint/parser": "^8.18.0",
    "eslint": "^9.17.0",
    "prettier": "^3.4.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.eslintrc.json`**

```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "module" },
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  "env": { "node": true, "es2022": true },
  "ignorePatterns": ["dist", "node_modules"],
  "rules": {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }]
  }
}
```

- [ ] **Step 5: Create `.prettierrc`**

```json
{ "singleQuote": true, "semi": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 6: Create `.editorconfig`**

```ini
root = true
[*]
charset = utf-8
indent_style = space
indent_size = 2
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
```

- [ ] **Step 7: Install and verify the toolchain**

Run: `npm install && npm run typecheck`
Expected: install succeeds; `typecheck` exits 0 (no source files yet → no errors).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .eslintrc.json .prettierrc .editorconfig package-lock.json
git commit -m "Scaffold TypeScript project (tsconfig, vitest, eslint, prettier)"
```

---

### Task 2: Concurrency semaphore

**Files:**
- Create: `src/lib/semaphore.ts`
- Test: `tests/lib/semaphore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/lib/semaphore.js';

describe('Semaphore', () => {
  it('limits concurrency to the configured max', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 6 }, task));
    expect(maxActive).toBe(2);
  });

  it('run() acquires and releases around a function, even on throw', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Lock must be released so the next run proceeds.
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/semaphore.test.ts`
Expected: FAIL — cannot find module `src/lib/semaphore.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/semaphore.ts
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
    this.available = max;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.available--;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.available++;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.available > 0) grant();
      else this.queue.push(grant);
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/semaphore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/semaphore.ts tests/lib/semaphore.test.ts
git commit -m "Add concurrency Semaphore"
```

---

### Task 3: Logger and paths

**Files:**
- Create: `src/lib/logger.ts`, `src/lib/paths.ts`
- Test: `tests/lib/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';

describe('createLogger', () => {
  it('writes to stderr, never stdout', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = createLogger('info');
    log.info('hello');
    expect(errSpy).toHaveBeenCalled();
    expect(outSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    outSpy.mockRestore();
  });

  it('suppresses debug when level is info', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const log = createLogger('info');
    log.debug('quiet');
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/logger.ts`**

```ts
// src/lib/logger.ts
// IMPORTANT: stdout carries the JSON-RPC stream on stdio transport.
// All logging MUST go to stderr.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel | string = 'info'): Logger {
  const threshold = ORDER[(level as LogLevel)] ?? ORDER.info;
  const emit = (lvl: LogLevel, args: unknown[]) => {
    if (ORDER[lvl] < threshold) return;
    const parts = args.map((a) =>
      typeof a === 'string' ? a : safeStringify(a),
    );
    process.stderr.write(`[zoteus] ${lvl.toUpperCase()} ${parts.join(' ')}\n`);
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
```

- [ ] **Step 4: Write `src/lib/paths.ts`**

```ts
// src/lib/paths.ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/** OS-appropriate default data directory for Zoteus caches and the search index. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZOTEUS_DATA_DIR) return env.ZOTEUS_DATA_DIR;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'zoteus');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'zoteus');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'zoteus');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/lib/logger.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/logger.ts src/lib/paths.ts tests/lib/logger.test.ts
git commit -m "Add stderr-only logger and default data-dir resolver"
```

---

### Task 4: Configuration loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
    expect(cfg.allowDelete).toBe(false);
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
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('abc');
    expect(cfg.libraryId).toBe(19552201);
    expect(cfg.libraryType).toBe('group');
    expect(cfg.local).toBe('off');
    expect(cfg.localPort).toBe(24000);
    expect(cfg.allowDelete).toBe(true);
    expect(cfg.scholarProviders).toEqual(['openalex', 'crossref']);
  });

  it('throws on an invalid enum value', () => {
    expect(() => loadConfig({ ZOTEUS_LOCAL: 'maybe' } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/config.ts`**

```ts
// src/config.ts
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
    scholarProviders: parsed.ZOTEUS_SCHOLAR_PROVIDERS.split(',').map((s) => s.trim()).filter(Boolean),
    dataDir: parsed.ZOTEUS_DATA_DIR ?? defaultDataDir(env),
    contactEmail: parsed.ZOTEUS_CONTACT_EMAIL,
    allowDelete: parsed.ZOTEUS_ALLOW_DELETE,
    logLevel: parsed.ZOTEUS_LOG_LEVEL,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Add zod-validated configuration loader"
```

---

### Task 5: API errors

**Files:**
- Create: `src/api/errors.ts`
- Test: `tests/api/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { ZoteroApiError, actionableMessage } from '../../src/api/errors.js';

const hdr = (h: Record<string, string>) => new Headers(h);

describe('actionableMessage', () => {
  it('explains a 412 version conflict and how to recover', () => {
    const msg = actionableMessage(412, '', hdr({ 'last-modified-version': '2114' }));
    expect(msg).toMatch(/changed on the server/i);
    expect(msg).toMatch(/2114/);
    expect(msg).toMatch(/re-fetch/i);
  });

  it('surfaces Retry-After for 429', () => {
    const msg = actionableMessage(429, '', hdr({ 'retry-after': '30' }));
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toMatch(/30/);
  });

  it('names the cause for 413 and 400', () => {
    expect(actionableMessage(413, 'Too many items', hdr({}))).toMatch(/too (large|many)/i);
    expect(actionableMessage(400, 'invalid itemType', hdr({}))).toMatch(/invalid itemType/);
  });
});

describe('ZoteroApiError', () => {
  it('carries status, retryAfter, and currentVersion', () => {
    const e = new ZoteroApiError({ status: 412, message: 'conflict', currentVersion: 2114 });
    expect(e.status).toBe(412);
    expect(e.currentVersion).toBe(2114);
    expect(e).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/api/errors.ts`**

```ts
// src/api/errors.ts
export interface ZoteroApiErrorInit {
  status: number;
  message: string;
  retryAfter?: number;
  currentVersion?: number;
  body?: string;
}

export class ZoteroApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;
  readonly currentVersion?: number;
  readonly body?: string;

  constructor(init: ZoteroApiErrorInit) {
    super(init.message);
    this.name = 'ZoteroApiError';
    this.status = init.status;
    this.retryAfter = init.retryAfter;
    this.currentVersion = init.currentVersion;
    this.body = init.body;
  }
}

/** Turn a Zotero HTTP failure into a message the model can act on. */
export function actionableMessage(status: number, body: string, headers: Headers): string {
  const detail = body?.trim() ? ` (${body.trim().slice(0, 200)})` : '';
  switch (status) {
    case 400:
      return `Zotero rejected the request as malformed${detail}. Check field names and itemType against the schema (zotero_schema).`;
    case 403:
      return `Access denied${detail}. Your API key may lack permission for this library or operation.`;
    case 404:
      return `Not found${detail}. The item/collection key or library may be wrong.`;
    case 409:
      return `The target library is locked (sync in progress)${detail}. Retry shortly.`;
    case 412: {
      const v = headers.get('last-modified-version');
      return `The object changed on the server since you fetched it${v ? ` (current version ${v})` : ''}. Re-fetch it with zotero_get_item and retry the write with the new version.`;
    }
    case 413:
      return `Request too large${detail}. Reduce batch size to <= 50 objects, or the file exceeds your storage quota.`;
    case 428:
      return `Missing precondition${detail}. A version (If-Unmodified-Since-Version) is required for this write.`;
    case 429: {
      const ra = headers.get('retry-after');
      return `Rate limited by Zotero. Wait ${ra ?? 'a few'} seconds before retrying${ra ? ` (Retry-After: ${ra}s)` : ''}.`;
    }
    case 503: {
      const ra = headers.get('retry-after');
      return `Zotero is temporarily unavailable. Retry after ${ra ?? 'a short delay'}${ra ? ` (${ra}s)` : ''}.`;
    }
    default:
      return `Zotero API error ${status}${detail}.`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/errors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/errors.ts tests/api/errors.test.ts
git commit -m "Add ZoteroApiError and actionable error messages"
```

---

### Task 6: RateLimitedFetcher (concurrency + backoff)

**Files:**
- Create: `src/api/http.ts`
- Test: `tests/api/http.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { RateLimitedFetcher } from '../../src/api/http.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

describe('RateLimitedFetcher', () => {
  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    const calls: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      calls.push(n);
      if (n === 1) return jsonResponse(429, 'slow down', { 'retry-after': '0' });
      return jsonResponse(200, { ok: true });
    });
    const f = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
    const res = await f.fetch('https://example.test/x');
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return jsonResponse(200, {});
    });
    const f = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => f.fetch('https://example.test/x')));
    expect(maxActive).toBe(2);
  });

  it('gives up after maxRetries and returns the last response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, 'down', { 'retry-after': '0' }));
    const f = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
    const res = await f.fetch('https://example.test/x', undefined, { maxRetries: 2 });
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/api/http.ts`**

```ts
// src/api/http.ts
import { Semaphore } from '../lib/semaphore.js';
import type { Logger } from '../lib/logger.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RateLimitedFetcherOptions {
  maxConcurrency?: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps fetch with the behavior every Zotero client must follow:
 *  - cap concurrent requests (default 4),
 *  - honor the `Backoff` header (applies to all subsequent requests),
 *  - retry on 429/503 honoring `Retry-After`, with exponential fallback.
 */
export class RateLimitedFetcher {
  private readonly sem: Semaphore;
  private readonly fetchImpl: FetchLike;
  private readonly logger?: Logger;
  private backoffUntil = 0;

  constructor(opts: RateLimitedFetcherOptions = {}) {
    this.sem = new Semaphore(opts.maxConcurrency ?? 4);
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.logger = opts.logger;
  }

  async fetch(url: string, init?: RequestInit, opts?: { maxRetries?: number }): Promise<Response> {
    const maxRetries = opts?.maxRetries ?? 4;
    return this.sem.run(async () => {
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await this.waitForBackoff();
        const res = await this.fetchImpl(url, init);
        this.observeBackoff(res);
        if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
          const wait = this.retryDelayMs(res, attempt);
          this.logger?.warn(`Zotero ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
          await sleep(wait);
          attempt++;
          continue;
        }
        return res;
      }
    });
  }

  private async waitForBackoff(): Promise<void> {
    const now = Date.now();
    if (this.backoffUntil > now) await sleep(this.backoffUntil - now);
  }

  private observeBackoff(res: Response): void {
    const backoff = res.headers.get('backoff');
    if (backoff) {
      const secs = Number(backoff);
      if (Number.isFinite(secs) && secs > 0) this.backoffUntil = Math.max(this.backoffUntil, Date.now() + secs * 1000);
    }
  }

  private retryDelayMs(res: Response, attempt: number): number {
    const ra = res.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) return secs * 1000;
    }
    return Math.min(2 ** attempt * 500, 30_000);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/http.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/http.ts tests/api/http.test.ts
git commit -m "Add RateLimitedFetcher with backoff and concurrency cap"
```

---

### Task 7: WebApiClient (cloud reads)

**Files:**
- Create: `src/api/web-client.ts`
- Test: `tests/api/web-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { WebApiClient } from '../../src/api/web-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function makeClient(fetchImpl: any) {
  const fetcher = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
  return new WebApiClient({ apiKey: 'KEY', fetcher });
}

describe('WebApiClient', () => {
  it('sends version + auth headers and resolves keysCurrent', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.zotero.org/keys/current');
      expect((init.headers as Record<string, string>)['Zotero-API-Key']).toBe('KEY');
      expect((init.headers as Record<string, string>)['Zotero-API-Version']).toBe('3');
      return new Response(JSON.stringify({ userID: 19552201, username: 'oscardvs', access: {} }), { status: 200 });
    });
    const info = await makeClient(fetchImpl).keysCurrent();
    expect(info.userID).toBe(19552201);
    expect(info.username).toBe('oscardvs');
  });

  it('lists items and parses Total-Results + Last-Modified-Version', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/users/19552201/items');
      expect(url).toContain('limit=2');
      expect(url).toContain('q=ai');
      return new Response(JSON.stringify([{ key: 'A' }, { key: 'B' }]), {
        status: 200,
        headers: { 'Total-Results': '138', 'Last-Modified-Version': '2114' },
      });
    });
    const r = await makeClient(fetchImpl).listItems(
      { type: 'user', id: 19552201 },
      { q: 'ai', limit: 2 },
    );
    expect(r.data).toHaveLength(2);
    expect(r.totalResults).toBe(138);
    expect(r.lastModifiedVersion).toBe(2114);
  });

  it('throws ZoteroApiError with an actionable message on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(
      makeClient(fetchImpl).getItem({ type: 'user', id: 1 }, 'XYZ'),
    ).rejects.toThrow(/not found/i);
  });

  it('fetches the global schema without auth', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.zotero.org/schema');
      return new Response(JSON.stringify({ version: 39, itemTypes: [] }), { status: 200 });
    });
    const schema = await makeClient(fetchImpl).getSchema();
    expect(schema.version).toBe(39);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/web-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/api/web-client.ts`**

```ts
// src/api/web-client.ts
import { RateLimitedFetcher } from './http.js';
import { ZoteroApiError, actionableMessage } from './errors.js';
import type { Logger } from '../lib/logger.js';

export interface LibraryRef {
  type: 'user' | 'group';
  id: number;
}

export interface KeyInfo {
  key?: string;
  userID: number;
  username: string;
  displayName?: string;
  access: Record<string, unknown>;
}

export interface ListResult<T = any> {
  data: T[];
  totalResults: number;
  lastModifiedVersion: number;
}

export interface ItemQuery {
  q?: string;
  qmode?: 'titleCreatorYear' | 'everything';
  itemType?: string;
  tag?: string | string[];
  sort?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  start?: number;
  since?: number;
  includeTrashed?: boolean;
  top?: boolean;
  collectionKey?: string;
  include?: string;
  format?: string;
}

export interface WebApiClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetcher?: RateLimitedFetcher;
  contactEmail?: string;
  logger?: Logger;
}

const DEFAULT_BASE = 'https://api.zotero.org';

export class WebApiClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetcher: RateLimitedFetcher;
  private readonly contactEmail?: string;

  constructor(opts: WebApiClientOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher({ logger: opts.logger });
    this.contactEmail = opts.contactEmail;
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Zotero-API-Version': '3' };
    if (this.apiKey) h['Zotero-API-Key'] = this.apiKey;
    const ua = this.contactEmail ? `zoteus (mailto:${this.contactEmail})` : 'zoteus';
    h['User-Agent'] = ua;
    return h;
  }

  private prefix(lib: LibraryRef): string {
    return lib.type === 'user' ? `/users/${lib.id}` : `/groups/${lib.id}`;
  }

  private buildQuery(params: Record<string, string | number | boolean | string[] | undefined>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
      else sp.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private async getJson(path: string, query = ''): Promise<{ json: any; headers: Headers }> {
    const url = `${this.baseUrl}${path}${query}`;
    const res = await this.fetcher.fetch(url, { method: 'GET', headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({
        status: res.status,
        message: actionableMessage(res.status, body, res.headers),
        retryAfter: numOrUndef(res.headers.get('retry-after')),
        currentVersion: numOrUndef(res.headers.get('last-modified-version')),
        body,
      });
    }
    return { json: await res.json(), headers: res.headers };
  }

  private toListResult<T>(json: T[], headers: Headers): ListResult<T> {
    return {
      data: json,
      totalResults: numOrUndef(headers.get('total-results')) ?? json.length,
      lastModifiedVersion: numOrUndef(headers.get('last-modified-version')) ?? 0,
    };
  }

  async keysCurrent(): Promise<KeyInfo> {
    const { json } = await this.getJson('/keys/current');
    return json as KeyInfo;
  }

  async getSchema(): Promise<any> {
    // The global schema endpoint takes no auth.
    const res = await this.fetcher.fetch(`${this.baseUrl}/schema`, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({ status: res.status, message: actionableMessage(res.status, body, res.headers) });
    }
    return res.json();
  }

  async listItems(lib: LibraryRef, query: ItemQuery = {}): Promise<ListResult> {
    const segment = query.top ? '/items/top' : '/items';
    const { top: _top, ...rest } = query;
    const { json, headers } = await this.getJson(this.prefix(lib) + segment, this.buildQuery(rest as any));
    return this.toListResult(json, headers);
  }

  async getItem(lib: LibraryRef, key: string, query: { include?: string; format?: string } = {}): Promise<any> {
    const { json } = await this.getJson(this.prefix(lib) + `/items/${key}`, this.buildQuery(query));
    return json;
  }

  async getItemChildren(lib: LibraryRef, key: string, query: ItemQuery = {}): Promise<ListResult> {
    const { json, headers } = await this.getJson(this.prefix(lib) + `/items/${key}/children`, this.buildQuery(query as any));
    return this.toListResult(json, headers);
  }

  async listCollections(lib: LibraryRef, query: { top?: boolean; limit?: number; start?: number } = {}): Promise<ListResult> {
    const segment = query.top ? '/collections/top' : '/collections';
    const { top: _t, ...rest } = query;
    const { json, headers } = await this.getJson(this.prefix(lib) + segment, this.buildQuery(rest as any));
    return this.toListResult(json, headers);
  }

  async listTags(lib: LibraryRef, query: { q?: string; limit?: number; start?: number } = {}): Promise<ListResult> {
    const { json, headers } = await this.getJson(this.prefix(lib) + '/tags', this.buildQuery(query as any));
    return this.toListResult(json, headers);
  }
}

function numOrUndef(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/web-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/web-client.ts tests/api/web-client.test.ts
git commit -m "Add WebApiClient cloud read surface"
```

---

### Task 8: LocalApiClient (desktop reads)

**Files:**
- Create: `src/api/local-client.ts`
- Test: `tests/api/local-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { LocalApiClient } from '../../src/api/local-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function makeLocal(fetchImpl: any, port = 23119) {
  return new LocalApiClient({ port, fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }) });
}

describe('LocalApiClient', () => {
  it('ping returns true when the local API responds', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('http://127.0.0.1:23119/api/users/0/items');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Total-Results': '0' } });
    });
    expect(await makeLocal(fetchImpl).ping()).toBe(true);
  });

  it('ping returns false on connection error', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await makeLocal(fetchImpl).ping()).toBe(false);
  });

  it('lists items against users/0', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items');
      expect(url).toContain('limit=5');
      return new Response(JSON.stringify([{ key: 'A' }]), { status: 200, headers: { 'Total-Results': '1', 'Last-Modified-Version': '10' } });
    });
    const r = await makeLocal(fetchImpl).listItems({ limit: 5 });
    expect(r.data).toHaveLength(1);
    expect(r.totalResults).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/local-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/api/local-client.ts`**

```ts
// src/api/local-client.ts
import { RateLimitedFetcher } from './http.js';
import type { ItemQuery, ListResult } from './web-client.js';

export interface LocalApiClientOptions {
  port?: number;
  fetcher?: RateLimitedFetcher;
}

/**
 * Read-only client for the Zotero desktop local API (Zotero 7+).
 * Base: http://127.0.0.1:<port>/api ; the personal library is always users/0.
 * Every endpoint is GET; there is no native local write support.
 */
export class LocalApiClient {
  static readonly LOCAL_USER_ID = 0;
  private readonly base: string;
  private readonly fetcher: RateLimitedFetcher;

  constructor(opts: LocalApiClientOptions = {}) {
    this.base = `http://127.0.0.1:${opts.port ?? 23119}/api`;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher();
  }

  private headers(): Record<string, string> {
    return { 'Zotero-API-Version': '3', 'x-zotero-connector-api-version': '3' };
  }

  private buildQuery(params: Record<string, string | number | boolean | string[] | undefined>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((i) => sp.append(k, String(i)));
      else sp.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private async getJson(path: string, query = ''): Promise<{ json: any; headers: Headers }> {
    const res = await this.fetcher.fetch(`${this.base}${path}${query}`, { method: 'GET', headers: this.headers() }, { maxRetries: 0 });
    if (!res.ok) throw new Error(`Local API ${res.status} for ${path}`);
    return { json: await res.json(), headers: res.headers };
  }

  private toListResult<T>(json: T[], headers: Headers): ListResult<T> {
    const tr = Number(headers.get('total-results'));
    const v = Number(headers.get('last-modified-version'));
    return { data: json, totalResults: Number.isFinite(tr) ? tr : json.length, lastModifiedVersion: Number.isFinite(v) ? v : 0 };
  }

  async ping(): Promise<boolean> {
    try {
      await this.getJson('/users/0/items', this.buildQuery({ limit: 1 }));
      return true;
    } catch {
      return false;
    }
  }

  async listItems(query: ItemQuery = {}): Promise<ListResult> {
    const segment = query.top ? '/items/top' : '/items';
    const { top: _t, ...rest } = query;
    const { json, headers } = await this.getJson(`/users/0${segment}`, this.buildQuery(rest as any));
    return this.toListResult(json, headers);
  }

  async getItem(key: string, query: { include?: string; format?: string } = {}): Promise<any> {
    const { json } = await this.getJson(`/users/0/items/${key}`, this.buildQuery(query));
    return json;
  }

  async listCollections(query: { top?: boolean; limit?: number; start?: number } = {}): Promise<ListResult> {
    const segment = query.top ? '/collections/top' : '/collections';
    const { top: _t, ...rest } = query;
    const { json, headers } = await this.getJson(`/users/0${segment}`, this.buildQuery(rest as any));
    return this.toListResult(json, headers);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/local-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/local-client.ts tests/api/local-client.test.ts
git commit -m "Add read-only LocalApiClient for the Zotero desktop API"
```

---

### Task 9: Capability probe

**Files:**
- Create: `src/router/capabilities.ts`
- Test: `tests/router/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { probeCapabilities } from '../../src/router/capabilities.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/lib/logger.js';

const logger = createLogger('error');

describe('probeCapabilities', () => {
  it('resolves cloud key info and local availability', async () => {
    const cfg = loadConfig({ ZOTERO_API_KEY: 'KEY', ZOTEUS_LOCAL: 'auto' } as any);
    const web = { hasKey: true, keysCurrent: vi.fn(async () => ({ userID: 19552201, username: 'oscardvs', access: {} })) };
    const local = { ping: vi.fn(async () => true) };
    const caps = await probeCapabilities(cfg, { web: web as any, local: local as any, logger });
    expect(caps.cloud?.userID).toBe(19552201);
    expect(caps.localApi).toBe(true);
  });

  it('treats an invalid key as no cloud access without throwing', async () => {
    const cfg = loadConfig({ ZOTERO_API_KEY: 'BAD', ZOTEUS_LOCAL: 'off' } as any);
    const web = { hasKey: true, keysCurrent: vi.fn(async () => { throw new Error('403'); }) };
    const local = { ping: vi.fn(async () => false) };
    const caps = await probeCapabilities(cfg, { web: web as any, local: local as any, logger });
    expect(caps.cloud).toBeNull();
    expect(caps.localApi).toBe(false);
  });

  it('skips the local probe when ZOTEUS_LOCAL=off', async () => {
    const cfg = loadConfig({ ZOTEUS_LOCAL: 'off' } as any);
    const local = { ping: vi.fn(async () => true) };
    const caps = await probeCapabilities(cfg, { web: { hasKey: false } as any, local: local as any, logger });
    expect(local.ping).not.toHaveBeenCalled();
    expect(caps.localApi).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/router/capabilities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/router/capabilities.ts`**

```ts
// src/router/capabilities.ts
import type { ZoteusConfig } from '../config.js';
import type { WebApiClient, KeyInfo } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { Logger } from '../lib/logger.js';

export interface Capabilities {
  cloud: KeyInfo | null;
  localApi: boolean;
}

export interface ProbeDeps {
  web: Pick<WebApiClient, 'hasKey' | 'keysCurrent'>;
  local?: Pick<LocalApiClient, 'ping'>;
  logger: Logger;
}

export async function probeCapabilities(config: ZoteusConfig, deps: ProbeDeps): Promise<Capabilities> {
  const cloudPromise: Promise<KeyInfo | null> = deps.web.hasKey
    ? deps.web
        .keysCurrent()
        .then((info) => info)
        .catch((err) => {
          deps.logger.warn('Cloud key probe failed:', String(err));
          return null;
        })
    : Promise.resolve(null);

  const localPromise: Promise<boolean> =
    config.local !== 'off' && deps.local
      ? deps.local.ping().catch(() => false)
      : Promise.resolve(false);

  const [cloud, localApi] = await Promise.all([cloudPromise, localPromise]);
  deps.logger.info(`Capabilities: cloud=${cloud ? `user ${cloud.userID}` : 'none'}, localApi=${localApi}`);
  return { cloud, localApi };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/router/capabilities.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/router/capabilities.ts tests/router/capabilities.test.ts
git commit -m "Add startup capability probe (cloud key + local API)"
```

---

### Task 10: LibraryRouter (read routing)

**Files:**
- Create: `src/router/library-router.ts`
- Test: `tests/router/library-router.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };

function makeRouter(opts: { local: 'auto' | 'on' | 'off'; localApi: boolean }) {
  const web = {
    listItems: vi.fn(async () => ({ data: [{ key: 'CLOUD' }], totalResults: 1, lastModifiedVersion: 1 })),
    getItem: vi.fn(async () => ({ key: 'CLOUD' })),
  };
  const local = {
    listItems: vi.fn(async () => ({ data: [{ key: 'LOCAL' }], totalResults: 1, lastModifiedVersion: 1 })),
    getItem: vi.fn(async () => ({ key: 'LOCAL' })),
  };
  const cfg = loadConfig({ ZOTEUS_LOCAL: opts.local } as any);
  const router = new LibraryRouter({
    config: cfg,
    capabilities: { cloud: cloudInfo as any, localApi: opts.localApi },
    web: web as any,
    local: local as any,
  });
  return { router, web, local };
}

describe('LibraryRouter', () => {
  it('reads from the local API when available and not disabled', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    const r = await router.searchItems({ q: 'x' });
    expect(r.data[0].key).toBe('LOCAL');
    expect(local.listItems).toHaveBeenCalled();
    expect(web.listItems).not.toHaveBeenCalled();
  });

  it('falls back to the cloud when local is unavailable', async () => {
    const { router, web } = makeRouter({ local: 'auto', localApi: false });
    const r = await router.searchItems({ q: 'x' });
    expect(r.data[0].key).toBe('CLOUD');
    expect(web.listItems).toHaveBeenCalled();
  });

  it('always uses the cloud for an explicit group library', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    await router.searchItems({ q: 'x', library: { type: 'group', id: 999 } });
    expect(web.listItems).toHaveBeenCalled();
    expect(local.listItems).not.toHaveBeenCalled();
  });

  it('defaultLibrary uses the resolved cloud userID', () => {
    const { router } = makeRouter({ local: 'auto', localApi: true });
    expect(router.defaultLibrary()).toEqual({ type: 'user', id: 19552201 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/router/library-router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/router/library-router.ts`**

```ts
// src/router/library-router.ts
import type { ZoteusConfig } from '../config.js';
import type { Capabilities } from './capabilities.js';
import type { WebApiClient, LibraryRef, ItemQuery, ListResult, KeyInfo } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';

export interface LibraryRouterOptions {
  config: ZoteusConfig;
  capabilities: Capabilities;
  web: WebApiClient;
  local?: LocalApiClient;
}

export interface ReadOpts {
  library?: LibraryRef;
}

/**
 * Decides whether a READ is served by the desktop local API or the cloud Web API.
 * Rule: use local only for the default personal (user) library when the local API
 * is up and not disabled; everything else (group libraries, or local down) → cloud.
 */
export class LibraryRouter {
  private readonly config: ZoteusConfig;
  private readonly capabilities: Capabilities;
  private readonly web: WebApiClient;
  private readonly local?: LocalApiClient;

  constructor(opts: LibraryRouterOptions) {
    this.config = opts.config;
    this.capabilities = opts.capabilities;
    this.web = opts.web;
    this.local = opts.local;
  }

  whoami(): KeyInfo | null {
    return this.capabilities.cloud;
  }

  defaultLibrary(): LibraryRef {
    if (this.config.libraryId) return { type: this.config.libraryType, id: this.config.libraryId };
    if (this.capabilities.cloud) return { type: 'user', id: this.capabilities.cloud.userID };
    // Local-only mode: the desktop personal library is addressed as users/0.
    return { type: 'user', id: 0 };
  }

  private useLocal(library: LibraryRef): boolean {
    if (!this.local || !this.capabilities.localApi || this.config.local === 'off') return false;
    const def = this.defaultLibrary();
    // Local API only serves the personal library (users/0 maps to the default user library).
    return library.type === 'user' && (library.id === def.id || library.id === 0);
  }

  async searchItems(query: ItemQuery & ReadOpts = {}): Promise<ListResult> {
    const { library, ...q } = query;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib)) return this.local!.listItems(q);
    return this.web.listItems(lib, q);
  }

  async getItem(key: string, opts: ReadOpts & { include?: string; format?: string } = {}): Promise<any> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib)) return this.local!.getItem(key, rest);
    return this.web.getItem(lib, key, rest);
  }

  async getItemChildren(key: string, opts: ReadOpts & ItemQuery = {}): Promise<ListResult> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    // Children are always available via the cloud; local may not implement /children uniformly.
    return this.web.getItemChildren(lib, key, rest);
  }

  async listCollections(opts: ReadOpts & { top?: boolean; limit?: number; start?: number } = {}): Promise<ListResult> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib)) return this.local!.listCollections(rest);
    return this.web.listCollections(lib, rest);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/router/library-router.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/router/library-router.ts tests/router/library-router.test.ts
git commit -m "Add LibraryRouter for local-vs-cloud read routing"
```

---

### Task 11: SchemaService

**Files:**
- Create: `src/schema/schema-service.ts`
- Test: `tests/schema/schema-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { SchemaService } from '../../src/schema/schema-service.js';

describe('SchemaService', () => {
  it('fetches once and caches subsequent calls', async () => {
    const getSchema = vi.fn(async () => ({ version: 39, itemTypes: [{ itemType: 'book' }] }));
    const svc = new SchemaService({ web: { getSchema } as any });
    const a = await svc.getSchema();
    const b = await svc.getSchema();
    expect(a.version).toBe(39);
    expect(b).toBe(a);
    expect(getSchema).toHaveBeenCalledTimes(1);
  });

  it('lists item type names', async () => {
    const getSchema = vi.fn(async () => ({ version: 1, itemTypes: [{ itemType: 'book' }, { itemType: 'journalArticle' }] }));
    const svc = new SchemaService({ web: { getSchema } as any });
    expect(await svc.itemTypeNames()).toEqual(['book', 'journalArticle']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schema/schema-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/schema/schema-service.ts`**

```ts
// src/schema/schema-service.ts
import type { WebApiClient } from '../api/web-client.js';

export interface ZoteroSchema {
  version: number;
  itemTypes: Array<{ itemType: string; fields?: Array<{ field: string; baseField?: string }>; creatorTypes?: Array<{ creatorType: string; primary?: boolean }> }>;
  [key: string]: unknown;
}

export interface SchemaServiceOptions {
  web: Pick<WebApiClient, 'getSchema'>;
}

/** Fetches and caches the global Zotero schema (item types, fields, creator types). */
export class SchemaService {
  private readonly web: Pick<WebApiClient, 'getSchema'>;
  private cache?: ZoteroSchema;
  private inflight?: Promise<ZoteroSchema>;

  constructor(opts: SchemaServiceOptions) {
    this.web = opts.web;
  }

  async getSchema(): Promise<ZoteroSchema> {
    if (this.cache) return this.cache;
    if (!this.inflight) {
      this.inflight = this.web.getSchema().then((s: ZoteroSchema) => {
        this.cache = s;
        this.inflight = undefined;
        return s;
      });
    }
    return this.inflight;
  }

  async itemTypeNames(): Promise<string[]> {
    const schema = await this.getSchema();
    return schema.itemTypes.map((t) => t.itemType);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/schema/schema-service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/schema/schema-service.ts tests/schema/schema-service.test.ts
git commit -m "Add SchemaService with caching"
```

---

### Task 12: Tool registry (types + adapter)

**Files:**
- Create: `src/registry/registry.ts`
- Test: covered by the integration test in Task 17.

- [ ] **Step 1: Write `src/registry/registry.ts`**

```ts
// src/registry/registry.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type { ZoteusConfig } from '../config.js';
import type { Capabilities } from '../router/capabilities.js';
import type { LibraryRouter } from '../router/library-router.js';
import type { SchemaService } from '../schema/schema-service.js';
import type { WebApiClient } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { Logger } from '../lib/logger.js';
import { ZoteroApiError } from '../api/errors.js';

export interface ToolContext {
  config: ZoteusConfig;
  capabilities: Capabilities;
  router: LibraryRouter;
  schema: SchemaService;
  web: WebApiClient;
  local?: LocalApiClient;
  logger: Logger;
}

export interface ToolHandlerResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema?: ZodRawShape;
  annotations?: ToolAnnotations;
  deferLoading?: boolean;
  handler: (args: any, ctx: ToolContext) => Promise<ToolHandlerResult>;
}

/** Convenience to build a successful result that mirrors structured data into a text block. */
export function ok(structured: Record<string, unknown>, summary: string): ToolHandlerResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: structured };
}

export function registerAllTools(server: McpServer, defs: ToolDefinition[], ctx: ToolContext): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema,
        annotations: { title: def.title, openWorldHint: true, ...def.annotations },
      },
      async (args: unknown) => {
        try {
          const result = await def.handler(args, ctx);
          return result;
        } catch (err) {
          const message =
            err instanceof ZoteroApiError ? err.message : err instanceof Error ? err.message : String(err);
          ctx.logger.error(`Tool ${def.name} failed:`, message);
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/registry/registry.ts
git commit -m "Add tool registry types and McpServer registration adapter"
```

---

### Task 13: `zotero_whoami` tool

**Files:**
- Create: `src/tools/whoami.ts`
- Test: `tests/tools/whoami.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import whoami from '../../src/tools/whoami.js';

function ctxWith(cloud: any) {
  return {
    router: { whoami: () => cloud, defaultLibrary: () => ({ type: 'user', id: cloud?.userID ?? 0 }) },
    capabilities: { cloud, localApi: true },
  } as any;
}

describe('zotero_whoami', () => {
  it('returns the resolved identity and access', async () => {
    const res = await whoami.handler({}, ctxWith({ userID: 19552201, username: 'oscardvs', access: { user: { write: true } } }));
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.userID).toBe(19552201);
    expect(res.content[0].text).toMatch(/oscardvs/);
  });

  it('reports local-only mode when no cloud key is configured', async () => {
    const res = await whoami.handler({}, ctxWith(null));
    expect(res.structuredContent?.cloud).toBe(false);
    expect(res.content[0].text).toMatch(/local/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/whoami.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tools/whoami.ts`**

```ts
// src/tools/whoami.ts
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const whoami: ToolDefinition = {
  name: 'zotero_whoami',
  title: 'Zotero identity & access',
  description:
    'Resolve the current Zotero identity (userID, username, display name) and per-library access scopes from the configured API key, and report which library backends are available (cloud Web API and/or the desktop local API). Call this first to discover the userID — never ask the user to type a numeric ID. If no API key is configured, the server runs in local-only read mode against the desktop library (users/0).',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_args, ctx) => {
    const cloud = ctx.router.whoami();
    const lib = ctx.router.defaultLibrary();
    const structured = {
      cloud: Boolean(cloud),
      userID: cloud?.userID,
      username: cloud?.username,
      displayName: cloud?.displayName,
      access: cloud?.access ?? null,
      localApi: ctx.capabilities.localApi,
      defaultLibrary: lib,
    };
    const summary = cloud
      ? `Signed in as ${cloud.username} (userID ${cloud.userID}). Local API: ${ctx.capabilities.localApi ? 'available' : 'unavailable'}.`
      : `No cloud API key configured — running in local-only read mode (local API ${ctx.capabilities.localApi ? 'available' : 'unavailable'}).`;
    return ok(structured, summary);
  },
};

export default whoami;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/whoami.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/whoami.ts tests/tools/whoami.test.ts
git commit -m "Add zotero_whoami tool"
```

---

### Task 14: `zotero_search_items` tool

**Files:**
- Create: `src/tools/search-items.ts`
- Test: `tests/tools/search-items.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import searchItems from '../../src/tools/search-items.js';

function ctx(searchImpl: any) {
  return { router: { searchItems: searchImpl, defaultLibrary: () => ({ type: 'user', id: 19552201 }) } } as any;
}

const sampleItem = {
  key: 'ABCD1234',
  version: 2114,
  data: { itemType: 'journalArticle', title: 'Deep Learning', date: '2021', creators: [{ creatorType: 'author', lastName: 'Hinton', firstName: 'G.' }] },
};

describe('zotero_search_items', () => {
  it('returns concise projections by default', async () => {
    const router = vi.fn(async () => ({ data: [sampleItem], totalResults: 1, lastModifiedVersion: 2114 }));
    const res = await searchItems.handler({ q: 'deep learning' }, ctx(router));
    expect(router).toHaveBeenCalled();
    const items = res.structuredContent?.items as any[];
    expect(items[0].title).toBe('Deep Learning');
    expect(items[0].key).toBe('ABCD1234');
    expect(items[0].creatorSummary).toMatch(/Hinton/);
    // concise mode omits raw version
    expect(items[0].version).toBeUndefined();
  });

  it('includes technical fields when response_format=detailed', async () => {
    const router = vi.fn(async () => ({ data: [sampleItem], totalResults: 1, lastModifiedVersion: 2114 }));
    const res = await searchItems.handler({ q: 'x', response_format: 'detailed' }, ctx(router));
    const items = res.structuredContent?.items as any[];
    expect(items[0].version).toBe(2114);
  });

  it('passes boolean tag/itemType filters through to the router', async () => {
    const router = vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 }));
    await searchItems.handler({ itemType: 'journalArticle || book', tag: 'to-read' }, ctx(router));
    expect(router).toHaveBeenCalledWith(expect.objectContaining({ itemType: 'journalArticle || book', tag: 'to-read' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/search-items.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tools/search-items.ts`**

```ts
// src/tools/search-items.ts
import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const MAX_LIMIT = 100;

export function creatorSummary(creators: Array<{ lastName?: string; name?: string }> = []): string {
  const names = creators.map((c) => c.lastName ?? c.name).filter(Boolean) as string[];
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(' & ');
  return `${names[0]} et al.`;
}

function project(item: any, detailed: boolean) {
  const d = item.data ?? item;
  const base: Record<string, unknown> = {
    key: item.key ?? d.key,
    itemType: d.itemType,
    title: d.title ?? d.caseName ?? d.subject ?? '(untitled)',
    creatorSummary: creatorSummary(d.creators),
    date: d.date,
  };
  if (detailed) {
    base.version = item.version ?? d.version;
    base.tags = (d.tags ?? []).map((t: any) => t.tag);
    base.collections = d.collections ?? [];
    base.DOI = d.DOI;
    base.url = d.url;
  }
  return base;
}

const searchItems: ToolDefinition = {
  name: 'zotero_search_items',
  title: 'Search Zotero items',
  description:
    'Search or list items in a Zotero library or collection. Supports full-text/quick search via `q` (`qmode`: titleCreatorYear=default, everything=includes notes & attachment full text), boolean `itemType` filters (use `||` for OR, repeat or `&&` for AND, leading `-` to negate, e.g. "journalArticle || book", "-attachment"), boolean `tag` filters (same syntax; escape a literal leading hyphen as "\\-"), `since` (version) for incremental queries, `sort`/`direction`, and `limit`/`start` paging. Set `response_format` to "detailed" to also return technical fields (version, tags, collections, DOI, url) needed before chaining a write; the default "concise" returns high-signal projections (key, itemType, title, creators, date). Reads are served from the fast desktop local API when available, otherwise the cloud Web API. Returns `totalResults` so you can tell when to page rather than assuming you saw everything.',
  inputSchema: {
    q: z.string().optional().describe('Quick/full-text search string.'),
    qmode: z.enum(['titleCreatorYear', 'everything']).optional(),
    itemType: z.string().optional().describe('Boolean itemType filter, e.g. "journalArticle || book".'),
    tag: z.string().optional().describe('Boolean tag filter, e.g. "to-read && 2024".'),
    collectionKey: z.string().optional().describe('Restrict to a collection by key.'),
    top: z.boolean().optional().describe('Only top-level items (exclude child notes/attachments).'),
    since: z.number().int().optional().describe('Return items modified after this library version.'),
    includeTrashed: z.boolean().optional(),
    sort: z.string().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Max items (default 25, max 100).'),
    start: z.number().int().min(0).optional(),
    response_format: z.enum(['concise', 'detailed']).optional().describe('Detail level of returned items.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const detailed = args.response_format === 'detailed';
    const library = args.library_id ? { type: args.library_type ?? 'group', id: args.library_id } : undefined;
    const result = await ctx.router.searchItems({
      q: args.q,
      qmode: args.qmode,
      itemType: args.itemType,
      tag: args.tag,
      collectionKey: args.collectionKey,
      top: args.top,
      since: args.since,
      includeTrashed: args.includeTrashed,
      sort: args.sort,
      direction: args.direction,
      limit: args.limit ?? 25,
      start: args.start,
      library,
    });
    const items = result.data.map((i) => project(i, detailed));
    const shown = items.length;
    const summary =
      `Found ${result.totalResults} item(s); showing ${shown}.` +
      (result.totalResults > shown + (args.start ?? 0)
        ? ' More available — narrow with q/tag/itemType or page with start.'
        : '');
    return ok({ items, totalResults: result.totalResults, libraryVersion: result.lastModifiedVersion }, summary);
  },
};

export default searchItems;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/search-items.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-items.ts tests/tools/search-items.test.ts
git commit -m "Add zotero_search_items tool with concise/detailed projections"
```

---

### Task 15: `zotero_get_item` tool

**Files:**
- Create: `src/tools/get-item.ts`
- Test: `tests/tools/get-item.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import getItem from '../../src/tools/get-item.js';

function ctx(getImpl: any, childrenImpl?: any) {
  return {
    router: {
      getItem: getImpl,
      getItemChildren: childrenImpl ?? vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })),
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
    },
  } as any;
}

describe('zotero_get_item', () => {
  it('returns the full item record', async () => {
    const getImpl = vi.fn(async () => ({ key: 'ABCD', version: 5, data: { itemType: 'book', title: 'T' } }));
    const res = await getItem.handler({ item_key: 'ABCD' }, ctx(getImpl));
    expect(getImpl).toHaveBeenCalledWith('ABCD', expect.any(Object));
    expect((res.structuredContent?.item as any).data.title).toBe('T');
  });

  it('includes children when requested', async () => {
    const getImpl = vi.fn(async () => ({ key: 'ABCD', data: { itemType: 'book' } }));
    const childrenImpl = vi.fn(async () => ({ data: [{ key: 'NOTE1', data: { itemType: 'note' } }], totalResults: 1, lastModifiedVersion: 5 }));
    const res = await getItem.handler({ item_key: 'ABCD', include_children: true }, ctx(getImpl, childrenImpl));
    expect(childrenImpl).toHaveBeenCalled();
    expect((res.structuredContent?.children as any[])[0].key).toBe('NOTE1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/get-item.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tools/get-item.ts`**

```ts
// src/tools/get-item.ts
import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const getItem: ToolDefinition = {
  name: 'zotero_get_item',
  title: 'Get a Zotero item',
  description:
    'Fetch one item by its key, returning the full item record (itemType, all bibliographic fields, creators, tags, collections, relations, version). Optionally set `include_children` to also return the item\'s child notes and attachments. Use `include` to additionally request rendered output: "bib" (formatted bibliography entry), "citation" (inline citation), or "csljson" (CSL-JSON for downstream formatting); combine with `style` (a CSL style id, default chicago-note-bibliography) and `locale`. The returned `version` is required if you later update or delete this item.',
  inputSchema: {
    item_key: z.string().describe('The 8-character Zotero item key.'),
    include_children: z.boolean().optional().describe('Also fetch child notes/attachments.'),
    include: z.string().optional().describe('Extra rendered content: "bib", "citation", or "csljson".'),
    style: z.string().optional().describe('CSL style id for bib/citation (default chicago-note-bibliography).'),
    locale: z.string().optional().describe('Locale for bib/citation, e.g. en-US.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const library = args.library_id ? { type: args.library_type ?? 'group', id: args.library_id } : undefined;
    const item = await ctx.router.getItem(args.item_key, {
      include: args.include,
      library,
    });
    const structured: Record<string, unknown> = { item };
    let summary = `Item ${args.item_key}: ${item?.data?.title ?? item?.title ?? '(no title)'}`;
    if (args.include_children) {
      const children = await ctx.router.getItemChildren(args.item_key, { library });
      structured.children = children.data;
      summary += ` (+${children.data.length} child item(s))`;
    }
    return ok(structured, summary);
  },
};

export default getItem;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/get-item.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/get-item.ts tests/tools/get-item.test.ts
git commit -m "Add zotero_get_item tool"
```

---

### Task 16: `zotero_schema` tool + tools index

**Files:**
- Create: `src/tools/schema.ts`, `src/tools/index.ts`
- Test: `tests/tools/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import schemaTool from '../../src/tools/schema.js';

function ctx() {
  return {
    schema: {
      getSchema: vi.fn(async () => ({ version: 39, itemTypes: [{ itemType: 'book', fields: [{ field: 'title' }], creatorTypes: [{ creatorType: 'author', primary: true }] }] })),
      itemTypeNames: vi.fn(async () => ['book']),
    },
  } as any;
}

describe('zotero_schema', () => {
  it('lists item types when no itemType is given', async () => {
    const res = await schemaTool.handler({}, ctx());
    expect(res.structuredContent?.version).toBe(39);
    expect(res.structuredContent?.itemTypes).toEqual(['book']);
  });

  it('returns fields and creator types for a specific itemType', async () => {
    const res = await schemaTool.handler({ item_type: 'book' }, ctx());
    expect((res.structuredContent?.fields as string[])).toContain('title');
    expect((res.structuredContent?.creatorTypes as string[])).toContain('author');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tools/schema.ts`**

```ts
// src/tools/schema.ts
import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const schemaTool: ToolDefinition = {
  name: 'zotero_schema',
  title: 'Zotero data model (types & fields)',
  description:
    'Return the Zotero data model so you never hardcode item shapes. With no arguments, returns the schema version and the list of all item type names. With `item_type`, returns the valid fields and creator types for that type (the "primary" creator type is listed first). Use this to validate an item before creating or updating it: notes, attachments, and annotations are item types too but bypass the normal field/creator model.',
  inputSchema: {
    item_type: z.string().optional().describe('If set, return the fields & creator types for this item type.'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const schema = await ctx.schema.getSchema();
    if (!args.item_type) {
      const itemTypes = schema.itemTypes.map((t) => t.itemType);
      return ok({ version: schema.version, itemTypes }, `Schema v${schema.version}: ${itemTypes.length} item types.`);
    }
    const t = schema.itemTypes.find((x) => x.itemType === args.item_type);
    if (!t) {
      return { content: [{ type: 'text', text: `Unknown item type "${args.item_type}". Call zotero_schema with no arguments to list valid types.` }], isError: true };
    }
    const fields = (t.fields ?? []).map((f) => f.field);
    const creatorTypes = (t.creatorTypes ?? []).map((c) => c.creatorType);
    return ok(
      { itemType: t.itemType, fields, creatorTypes, version: schema.version },
      `${t.itemType}: ${fields.length} fields, ${creatorTypes.length} creator types.`,
    );
  },
};

export default schemaTool;
```

- [ ] **Step 4: Write `src/tools/index.ts`**

```ts
// src/tools/index.ts
import type { ToolDefinition } from '../registry/registry.js';
import whoami from './whoami.js';
import searchItems from './search-items.js';
import getItem from './get-item.js';
import schemaTool from './schema.js';

export const tools: ToolDefinition[] = [whoami, searchItems, getItem, schemaTool];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/tools/schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/schema.ts src/tools/index.ts tests/tools/schema.test.ts
git commit -m "Add zotero_schema tool and tools index"
```

---

### Task 17: Resources, server wiring, stdio transport, entry point

**Files:**
- Create: `src/resources/index.ts`, `src/transports/stdio.ts`, `src/server.ts`, `src/index.ts`

- [ ] **Step 1: Write `src/resources/index.ts`**

```ts
// src/resources/index.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../registry/registry.js';

/** Registers read-only Zotero resources. */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'zotero-schema',
    'zotero://schema',
    { title: 'Zotero data model', description: 'Item types, fields, and creator types.', mimeType: 'application/json' },
    async (uri) => {
      const schema = await ctx.schema.getSchema();
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(schema) }] };
    },
  );

  server.registerResource(
    'zotero-collections',
    'zotero://collections',
    { title: 'Zotero collections', description: 'The default library\'s collection tree.', mimeType: 'application/json' },
    async (uri) => {
      const result = await ctx.router.listCollections({});
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result.data) }] };
    },
  );
}
```

- [ ] **Step 2: Write `src/transports/stdio.ts`**

```ts
// src/transports/stdio.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 3: Write `src/server.ts`**

```ts
// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZoteusConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { RateLimitedFetcher } from './api/http.js';
import { WebApiClient } from './api/web-client.js';
import { LocalApiClient } from './api/local-client.js';
import { probeCapabilities } from './router/capabilities.js';
import { LibraryRouter } from './router/library-router.js';
import { SchemaService } from './schema/schema-service.js';
import { registerAllTools, type ToolContext } from './registry/registry.js';
import { registerResources } from './resources/index.js';
import { tools } from './tools/index.js';

export interface BuiltServer {
  server: McpServer;
  ctx: ToolContext;
}

const VERSION = '0.1.0';

export async function buildServer(config: ZoteusConfig): Promise<BuiltServer> {
  const logger = createLogger(config.logLevel);
  const fetcher = new RateLimitedFetcher({ maxConcurrency: 4, logger });
  const web = new WebApiClient({ apiKey: config.apiKey, fetcher, contactEmail: config.contactEmail, logger });
  const local = config.local !== 'off' ? new LocalApiClient({ port: config.localPort, fetcher }) : undefined;

  const capabilities = await probeCapabilities(config, { web, local, logger });
  const router = new LibraryRouter({ config, capabilities, web, local });
  const schema = new SchemaService({ web });

  const ctx: ToolContext = { config, capabilities, router, schema, web, local, logger };

  const server = new McpServer(
    { name: 'zoteus', version: VERSION },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
      instructions:
        'Zoteus exposes your Zotero library. Call zotero_whoami first to resolve identity. Prefer zotero_search_items for discovery and zotero_get_item for full records. Use zotero_schema before constructing items.',
    },
  );

  registerAllTools(server, tools, ctx);
  registerResources(server, ctx);

  return { server, ctx };
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
#!/usr/bin/env node
// src/index.ts
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { startStdio } from './transports/stdio.js';
import { createLogger } from './lib/logger.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const { server } = await buildServer(config);
  // Only stdio in M0–M2. HTTP transport arrives in a later milestone.
  await startStdio(server);
  logger.info('Zoteus MCP server started on stdio.');
}

main().catch((err) => {
  process.stderr.write(`[zoteus] FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0; `dist/index.js` exists.

- [ ] **Step 6: Commit**

```bash
git add src/resources/index.ts src/transports/stdio.ts src/server.ts src/index.ts
git commit -m "Wire MCP server: resources, stdio transport, and entry point"
```

---

### Task 18: In-process integration test

**Files:**
- Create: `tests/integration/server.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools, type ToolContext } from '../../src/registry/registry.js';
import { registerResources } from '../../src/resources/index.js';
import { tools } from '../../src/tools/index.js';

function fakeCtx(): ToolContext {
  const cloud = { userID: 19552201, username: 'oscardvs', access: { user: { write: true } } };
  return {
    config: { local: 'off', libraryType: 'user' } as any,
    capabilities: { cloud: cloud as any, localApi: false },
    router: {
      whoami: () => cloud,
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      searchItems: vi.fn(async () => ({
        data: [{ key: 'ABCD1234', version: 2114, data: { itemType: 'journalArticle', title: 'Deep Learning', date: '2021', creators: [{ creatorType: 'author', lastName: 'Hinton' }] } }],
        totalResults: 1,
        lastModifiedVersion: 2114,
      })),
      getItem: vi.fn(async () => ({ key: 'ABCD1234', data: { itemType: 'journalArticle', title: 'Deep Learning' } })),
      getItemChildren: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })),
      listCollections: vi.fn(async () => ({ data: [{ key: 'COLL', data: { name: 'Reading' } }], totalResults: 1, lastModifiedVersion: 1 })),
    } as any,
    schema: { getSchema: vi.fn(async () => ({ version: 39, itemTypes: [{ itemType: 'book', fields: [{ field: 'title' }] }] })), itemTypeNames: vi.fn(async () => ['book']) } as any,
    web: {} as any,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

async function connect() {
  const server = new McpServer({ name: 'zoteus-test', version: '0.0.0' }, { capabilities: { tools: {}, resources: {} } });
  const ctx = fakeCtx();
  registerAllTools(server, tools, ctx);
  registerResources(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, ctx };
}

describe('Zoteus server (in-process)', () => {
  it('lists all four tools', async () => {
    const { client } = await connect();
    const { tools: listed } = await client.listTools();
    const names = listed.map((t) => t.name).sort();
    expect(names).toEqual(['zotero_get_item', 'zotero_schema', 'zotero_search_items', 'zotero_whoami']);
  });

  it('calls zotero_search_items and returns structured content', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({ name: 'zotero_search_items', arguments: { q: 'deep learning' } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.items[0].title).toBe('Deep Learning');
    expect(res.content[0].text).toMatch(/Found 1 item/);
  });

  it('calls zotero_whoami', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({ name: 'zotero_whoami', arguments: {} });
    expect(res.structuredContent.userID).toBe(19552201);
  });

  it('reads the zotero://collections resource', async () => {
    const { client } = await connect();
    const res: any = await client.readResource({ uri: 'zotero://collections' });
    const data = JSON.parse(res.contents[0].text);
    expect(data[0].data.name).toBe('Reading');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/server.test.ts
git commit -m "Add in-process integration test (InMemoryTransport)"
```

---

### Task 19: Opt-in end-to-end test against the live library

**Files:**
- Create: `tests/e2e/live.test.ts`

- [ ] **Step 1: Write the test (skips itself when no key)**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';

const hasKey = Boolean(process.env.ZOTERO_API_KEY);
const d = hasKey ? describe : describe.skip;

d('Zoteus e2e (live Zotero API)', () => {
  it('resolves whoami and searches real items', async () => {
    const config = loadConfig(process.env);
    const { ctx } = await buildServer(config);

    const me = ctx.router.whoami();
    expect(me?.username).toBeTruthy();

    const result = await ctx.router.searchItems({ limit: 3, top: true });
    expect(result.totalResults).toBeGreaterThan(0);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.length).toBeLessThanOrEqual(3);
  }, 30_000);
});
```

- [ ] **Step 2: Run it with the real key (loads `.env`)**

Run: `set -a && . ./.env && set +a && npx vitest run tests/e2e/live.test.ts`
Expected: PASS (1 test) when a valid key is present; otherwise the suite is skipped. Against the real library you should see `totalResults` ≈ 138 for top-level items.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/live.test.ts
git commit -m "Add opt-in e2e test against the live Zotero API"
```

---

### Task 20: Manual Inspector check, docs, and tag

**Files:**
- Modify: `README.md` (check the M0–M2 boxes), create `docs/configuration.md`

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites PASS (unit + integration; e2e skipped unless key present).

- [ ] **Step 2: Exercise the server in MCP Inspector**

Run: `set -a && . ./.env && set +a && npm run build && npx @modelcontextprotocol/inspector node dist/index.js`
Then in the Inspector UI: confirm 4 tools and 2 resources are listed; call `zotero_whoami` (expect username `oscardvs`); call `zotero_search_items` with `{"q":"","limit":5,"top":true}` (expect up to 5 items). Confirm nothing is written to stdout outside the JSON-RPC stream (no log lines corrupt the connection).

- [ ] **Step 3: Create `docs/configuration.md`**

```markdown
# Configuration

Zoteus is configured via environment variables (see `.env.example`).

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (writes/sync/groups; optional for local-only reads). Create at https://www.zotero.org/settings/keys |
| `ZOTERO_LIBRARY_ID` / `ZOTERO_LIBRARY_TYPE` | auto | Pin a library; otherwise resolved from the key. |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the Zotero desktop local API for reads. |
| `ZOTERO_LOCAL_PORT` | `23119` | Desktop local server port. |
| `ZOTEUS_TRANSLATION_SERVER_URL` | `http://127.0.0.1:1969` | Add-by-identifier/URL (later milestone). |
| `ZOTEUS_EMBEDDINGS` | `local` | Semantic-search embeddings provider (later milestone). |
| `ZOTEUS_DATA_DIR` | OS data dir | Index + caches. |
| `ZOTEUS_CONTACT_EMAIL` | — | Polite-pool contact for external scholarly APIs. |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose permanent delete (later milestone). |
| `ZOTEUS_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` (stderr only). |

## Local API prerequisite

To use the fast, key-free local read path, run Zotero 7+ and enable
**Settings → Advanced → "Allow other applications on this computer to communicate with Zotero."**
```

- [ ] **Step 4: Check the M0–M2 roadmap boxes in `README.md`**

Edit the roadmap list so milestones 0, 1, and 2 are checked:

```markdown
- [x] **0** Scaffold + CI
- [x] **1** Zotero API clients (cloud + local) + capability probe
- [x] **2** MCP core + read tools + resources (stdio)
```

- [ ] **Step 5: Commit and tag**

```bash
git add README.md docs/configuration.md
git commit -m "Document configuration and mark M0–M2 complete"
git tag v0.1.0
git push origin main --tags
```

---

## Self-review checklist (run before handoff)

- [ ] **Spec coverage (M0–M2):** scaffold (Task 1) ✓; cloud client w/ versioning+pagination+rate-limit (Tasks 6–7) ✓; local client (Task 8) ✓; capability probe (Task 9) ✓; routing (Task 10) ✓; schema cache (Task 11) ✓; MCP core + 4 read tools (Tasks 12–16) ✓; resources + stdio + entry (Task 17) ✓; integration + e2e (Tasks 18–19) ✓; Inspector + docs (Task 20) ✓. Write tools, files/sync, citation, search, scholar, code-exec, prompts, and HTTP transport are explicitly deferred to later plans (M3–M9).
- [ ] **No placeholders:** every code step contains complete code. (The `void z;` note in Task 13 is documented, not a TODO.)
- [ ] **Type consistency:** `LibraryRef`, `ItemQuery`, `ListResult`, `KeyInfo` are defined in `web-client.ts` and imported everywhere; `ToolDefinition`/`ToolContext`/`ToolHandlerResult` defined in `registry.ts`; `Capabilities` in `capabilities.ts`. `ok()` helper used by all tools. Tool names (`zotero_whoami`, `zotero_search_items`, `zotero_get_item`, `zotero_schema`) match between `tools/index.ts` and the integration test.
- [ ] **stdio safety:** logger writes only to stderr (Task 3 test asserts this).

## Definition of done (M0–M2)

`npm test` is green; `npm run build` produces `dist/index.js`; the server runs under MCP Inspector and answers `zotero_whoami`/`zotero_search_items` against the real library; `v0.1.0` is tagged and pushed.

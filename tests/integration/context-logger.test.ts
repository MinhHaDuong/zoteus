import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { buildContext } from '../../src/server.js';
import type { Logger } from '../../src/lib/logger.js';

/**
 * ZOTEUS_LOG_FILE captured "HTTP request lines only: build/update progress and errors never
 * appear in it" (#59). `main()` created one logger with the file attached and handed it to
 * the HTTP transport, but `buildContext` created a second one from the level and format
 * alone, and that second logger is the one every index build, the embedder and the Zotero
 * clients log through. These cases pin the wiring: a context logs through the logger it is
 * given, and one built without a logger still writes the file the configuration names.
 */

/** One page of one item, then the end: enough for a build to log its start and its finish. */
const onePage = async (start: number) => ({
  items:
    start === 0
      ? [{ key: 'AAAAAAAA', data: { key: 'AAAAAAAA', itemType: 'journalArticle', title: 'Coastal erosion', abstractNote: 'retreat' } }]
      : [],
  totalResults: 1,
  lastModifiedVersion: 7,
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    // Hermetic: no desktop app, no cloud key to probe, no release lookup, a disposable data dir.
    ZOTEUS_LOCAL: 'off',
    ZOTEUS_UPDATE_CHECK: 'false',
    ZOTEUS_INDEX_BACKEND: 'memory',
    ZOTEUS_DATA_DIR: mkdtempSync(join(tmpdir(), 'zoteus-ctx-logger-')),
    ...extra,
  } as NodeJS.ProcessEnv;
}

async function fileHolding(path: string, expected: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const text = readFileSync(path, 'utf8');
      if (text.includes(expected)) return text;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${path} never held "${expected}"`);
}

describe('the tool context logs through the server logger', () => {
  it("routes an index build's lines to the logger main() created", async () => {
    const lines: string[] = [];
    const record = (level: string) => (...a: unknown[]) => void lines.push(`${level} ${a.map(String).join(' ')}`);
    const logger: Logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
    const ctx = await buildContext(loadConfig(env()), { telemetry: { logger } });
    expect(ctx.logger).toBe(logger);

    await ctx.search.buildIncremental(onePage, {});
    expect(ctx.search.buildStatus().state).toBe('done');
    // The build's own completion line, as written by the index the context holds: it used
    // to reach a logger nothing else could see.
    expect(lines.some((l) => l.startsWith('info index build complete: 1 of 1 items indexed'))).toBe(true);
    await ctx.search.close();
  });

  it('still writes ZOTEUS_LOG_FILE from a context built without a logger', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'zoteus-ctx-logfile-')), 'zoteus.log');
    const ctx = await buildContext(loadConfig(env({ ZOTEUS_LOG_FILE: path })));
    await ctx.search.buildIncremental(onePage, {});
    const text = await fileHolding(path, 'index build complete');
    expect(text).toContain('[zoteus] INFO index build complete: 1 of 1 items indexed');
    await ctx.search.close();
  });
});

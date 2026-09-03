import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import {
  EMBED_TOKENS_PER_REQUEST_HINT,
  EMBED_TPM_HINT,
  embedRateLine,
  embedRateNotice,
  statusSummary,
} from '../../src/features/search/build.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';
import type { IndexBuildStatus } from '../../src/features/search/backend.js';
import { loadConfig } from '../../src/config.js';

/**
 * The fourth request in #48: surface the rate math. The reporter had to read the provider's
 * dashboard against `dist/config.js` to discover that their build was sitting exactly on
 * OpenAI's tokens-per-minute ceiling, because nothing Zoteus printed mentioned a rate at
 * all. It costs one log line and one status field to hand that over.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const BODY = 'The ablation removes the recurrent gate under mixed precision. '.repeat(400);

function makeLibrary(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
  }));
}

function pager(library: any[]) {
  return async (start: number) => ({ items: library.slice(start, start + 100), totalResults: library.length });
}

function apiEmbedder(name: 'openai' | 'gemini' = 'openai'): EmbeddingProvider {
  return {
    name,
    model: 'text-embedding-3-small',
    embed: async (batch) => batch.map(() => [1, 0, 0]),
  };
}

/** A status carrying nothing but the rate, for the notice under test. */
function statusWith(embedRate: IndexBuildStatus['embedRate']): IndexBuildStatus {
  return { embedRate } as IndexBuildStatus;
}

describe('the rate a build is embedding at', () => {
  it('is on the status of an API build, in the units a provider quotes its limits in', async () => {
    const search = new MemorySearchIndex({
      embedder: apiEmbedder(),
      configured: 'openai',
      logger: silentLogger,
    });
    const final = await search.buildIncremental(pager(makeLibrary(20)), {
      fulltextFor: async () => BODY,
      fulltextKeys: async () => new Set(makeLibrary(20).map((i) => i.key as string)),
      embedBatchSize: 256,
    });

    expect(final.embedRate).toBeDefined();
    expect(final.embedRate!.batchSize).toBe(256);
    expect(final.embedRate!.delayMs).toBe(0);
    // 256 body passages of 1200 characters, at four characters per token.
    expect(final.embedRate!.tokensPerRequest).toBe((256 * 1200) / 4);
  });

  it('is absent for a local pipeline, which answers to no tokens-per-minute limit', async () => {
    const local: EmbeddingProvider = { name: 'local', model: 'all-MiniLM-L6-v2', embed: async (b) => b.map(() => [1]) };
    const search = new MemorySearchIndex({ embedder: local, configured: 'local', logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(5)));
    expect(final.embedRate).toBeUndefined();
  });

  it('quotes the metadata chunk size on a build that is not crawling bodies', async () => {
    const search = new MemorySearchIndex({ embedder: apiEmbedder(), configured: 'openai', logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(5)), { embedBatchSize: 100 });
    expect(final.embedRate!.tokensPerRequest).toBe((100 * 512) / 4);
  });

  it('is announced in the log when the pass that does the spending begins', async () => {
    const logger = { ...silentLogger, info: vi.fn() };
    const search = new MemorySearchIndex({ embedder: apiEmbedder(), configured: 'openai', logger });
    await search.buildIncremental(pager(makeLibrary(20)), {
      fulltextFor: async () => BODY,
      fulltextKeys: async () => new Set(makeLibrary(20).map((i) => i.key as string)),
      embedBatchSize: 256,
      embedBatchDelayMs: 250,
    });

    const lines = logger.info.mock.calls.map((c) => String(c[0]));
    const rate = lines.find((l) => l.includes('embedding through openai'));
    expect(rate).toBeDefined();
    expect(rate).toContain('256 passages per request (ZOTEUS_EMBED_BATCH_SIZE)');
    expect(rate).toContain('76,800 tokens each');
    expect(rate).toContain('250 ms pause between requests');
  });

  it('reads as a sentence in both pacings', () => {
    expect(embedRateLine({ batchSize: 32, delayMs: 0, tokensPerRequest: 9_600 })).toBe(
      '32 passages per request (ZOTEUS_EMBED_BATCH_SIZE), about 9,600 tokens each, with no pause between ' +
        'requests (ZOTEUS_EMBED_BATCH_DELAY_MS=0), so the rate is set only by how fast the provider answers',
    );
    expect(embedRateLine({ batchSize: 256, delayMs: 8000, tokensPerRequest: 76_800, tokensPerMinute: 412_000 })).toContain(
      'measured at 412,000 tokens/min so far',
    );
  });
});

describe('what the rate math tells the user to do', () => {
  it('says nothing at all about a build that is nowhere near a limit', () => {
    expect(embedRateNotice(statusWith({ batchSize: 32, delayMs: 0, tokensPerRequest: 9_600, tokensPerMinute: 120_000 }))).toBe('');
  });

  it('names the delay when the build is riding the tokens-per-minute ceiling', () => {
    const notice = embedRateNotice(
      statusWith({ batchSize: 500, delayMs: 0, tokensPerRequest: 150_000, tokensPerMinute: EMBED_TPM_HINT }),
    );
    expect(notice).toContain('ZOTEUS_EMBED_BATCH_DELAY_MS');
    expect(notice).toContain('ZOTEUS_EMBED_BATCH_SIZE=256');
    expect(notice).toContain('800,000 tokens/min');
  });

  it('names the batch size when one request is close to the size a provider rejects whole', () => {
    const notice = embedRateNotice(
      statusWith({ batchSize: 1000, delayMs: 0, tokensPerRequest: EMBED_TOKENS_PER_REQUEST_HINT + 1 }),
    );
    expect(notice).toContain('lower ZOTEUS_EMBED_BATCH_SIZE');
    expect(notice).toContain('300,000');
    // A 400 is not a rate limit, so the delay is not the remedy offered here.
    expect(notice).not.toContain('ZOTEUS_EMBED_BATCH_DELAY_MS');
  });

  it('rides along on the index status summary, where a user polling a build reads it', () => {
    const s = {
      state: 'building',
      operation: 'build',
      embedderActive: true,
      embedderConfigured: 'openai',
      embedRate: { batchSize: 500, delayMs: 0, tokensPerRequest: 150_000, tokensPerMinute: 1_000_000 },
      itemsFetched: 1,
      itemsTotal: 1,
      itemsAvailable: 1,
      items: 1,
      passages: 1,
      documents: 1,
      vectors: 1,
      phase: 'fulltext',
      fulltextItemsScanned: 1,
      fulltextItemsTotal: 1,
      fulltextEnabled: true,
      fulltextItems: 1,
      fulltextPassages: 1,
      itemsRemoved: 0,
      embedder: 'openai',
    } as unknown as IndexBuildStatus;
    expect(statusSummary(s)).toContain('1,000,000 tokens/min');
  });
});

describe('the two throttle dials are documented where a failing user looks', () => {
  const seen = (path: string) => readFileSync(path, 'utf8');

  it('are in the README table, not only in the full configuration reference', () => {
    const readme = seen('README.md');
    expect(readme).toContain('ZOTEUS_EMBED_BATCH_SIZE');
    expect(readme).toContain('ZOTEUS_EMBED_BATCH_DELAY_MS');
  });

  it('are named by the desktop extension settings that set them', () => {
    const manifest = seen('mcpb/manifest.json');
    expect(manifest).toContain('ZOTEUS_EMBED_BATCH_SIZE');
    // Each field description points at the other, since neither dial works alone.
    const fields = JSON.parse(manifest).user_config;
    expect(fields.embed_batch_delay_ms.description).toMatch(/batch size 256/);
    expect(fields.embed_batch_size.description).toMatch(/8000 ms/);
  });

  it('are named by the tool description the model reads before it explains a failure', () => {
    const tool = seen('src/tools/index-tool.ts');
    expect(tool).toContain('ZOTEUS_EMBED_BATCH_DELAY_MS');
    expect(tool).toContain('passagesWithoutVectors');
  });

  it('include the retry ceiling, which config parses and defaults', () => {
    expect(loadConfig({} as any).embedMaxRetries).toBe(5);
    expect(loadConfig({ ZOTEUS_EMBED_MAX_RETRIES: '0' } as any).embedMaxRetries).toBe(0);
    expect(seen('docs/configuration.md')).toContain('ZOTEUS_EMBED_MAX_RETRIES');
  });
});

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchIndex } from '../../src/features/search/index-manager.js';
import { statusSummary } from '../../src/features/search/build.js';
import {
  createEmbeddingProvider,
  missingTransformersHint,
  resolveTransformers,
  TRANSFORMERS_MODULE,
  type EmbeddingProvider,
} from '../../src/features/search/embeddings.js';
import { loadConfig } from '../../src/config.js';
import indexTool from '../../src/tools/index-tool.js';
import semanticSearch from '../../src/tools/semantic-search.js';
import { STORES } from './stores.js';
import type { PassageStore } from '../../src/features/search/passage-store.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

const items = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Neural networks', abstractNote: 'deep learning' } },
  { key: 'B', data: { itemType: 'book', title: 'Gardening', abstractNote: 'tomatoes' } },
];

/** An index built while the local runtime is missing: keyword docs, zero vectors. */
function keywordOnlyIndex(store?: PassageStore): SearchIndex {
  return new SearchIndex({
    embedder: null,
    configured: 'local',
    unavailable: missingTransformersHint({ dist: 'mcpb' }),
    logger: silentLogger,
    store,
  });
}

describe('resolveTransformers', () => {
  it('finds the package under a configured root, and from the package directory itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'zoteus-hf-'));
    const pkgDir = join(root, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: TRANSFORMERS_MODULE, main: 'index.js' }));
    writeFileSync(join(pkgDir, 'index.js'), 'export const pipeline = () => {};');

    // the directory that holds node_modules (what `npm root -g`'s parent looks like)
    expect(resolveTransformers(root)).toMatch(/transformers\/index\.js$/);
    // the package directory itself: Node's walk-up reaches the same node_modules
    expect(resolveTransformers(pkgDir)).toMatch(/transformers\/index\.js$/);
  });

  it('accepts an npm prefix whose modules live under lib/node_modules', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'zoteus-prefix-'));
    const pkgDir = join(prefix, 'lib', 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: TRANSFORMERS_MODULE, main: 'index.js' }));
    writeFileSync(join(pkgDir, 'index.js'), 'export const pipeline = () => {};');
    expect(resolveTransformers(prefix)).toMatch(/transformers\/index\.js$/);
  });

  it('returns null for a path that has no such package', () => {
    expect(resolveTransformers(mkdtempSync(join(tmpdir(), 'zoteus-empty-')))).toBeNull();
  });
});

describe('createEmbeddingProvider preflight', () => {
  it('reports local as unavailable (not as an active provider) when the runtime is missing', () => {
    const config = loadConfig({
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_TRANSFORMERS_PATH: mkdtempSync(join(tmpdir(), 'zoteus-none-')),
      ZOTEUS_DIST: 'mcpb',
    } as any);
    const selection = createEmbeddingProvider(config, silentLogger);
    expect(selection.provider).toBeNull();
    expect(selection.configured).toBe('local');
    expect(selection.unavailable).toMatch(/@huggingface\/transformers is not installed/);
    // the bundled-install wording names the escape hatch, not a bare `npm i`
    expect(selection.unavailable).toMatch(/ZOTEUS_TRANSFORMERS_PATH/);
  });

  it('flags an API provider whose key is missing rather than pretending it is active', () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const selection = createEmbeddingProvider(loadConfig({ ZOTEUS_EMBEDDINGS: 'openai' } as any), silentLogger);
      expect(selection.provider).toBeNull();
      expect(selection.unavailable).toMatch(/OPENAI_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });
});

describe.each(STORES)('status reports the effective embedder, not the configured one [%s]', (_name, makeStore) => {
  it('names the requested provider and the reason it is not running', async () => {
    const search = keywordOnlyIndex(makeStore());
    await search.build(items);
    const status = search.buildStatus();

    expect(status.vectors).toBe(0);
    expect(status.embedderConfigured).toBe('local');
    expect(status.embedderActive).toBe(false);
    expect(status.embedder).toMatch(/^none \(local requested;/);
    expect(status.embedderReason).toMatch(/@huggingface\/transformers/);
    expect(statusSummary(status)).toMatch(/Semantic ranking is OFF/);
  });

  it('keeps reporting the failure after a build in which the provider threw', async () => {
    const broken: EmbeddingProvider = {
      name: 'local',
      embed: async () => {
        throw new Error('onnxruntime binding missing');
      },
    };
    const search = new SearchIndex({ embedder: broken, configured: 'local', logger: silentLogger, store: makeStore() });
    await search.build(items);

    // The build still completes on keyword data, but it no longer claims to be embedding.
    expect(search.buildStatus().vectors).toBe(0);
    expect(search.embedderActive).toBe(false);
    expect(search.embedderName).toMatch(/none \(local requested; onnxruntime binding missing\)/);
    expect((await search.query('deep learning')).length).toBeGreaterThan(0);
  });

  it('says nothing extra when embeddings were switched off on purpose', async () => {
    const search = new SearchIndex({ embedder: null, configured: 'off', logger: silentLogger, store: makeStore() });
    await search.build(items);
    const status = search.buildStatus();
    expect(status.embedder).toBe('none (keyword-only)');
    expect(statusSummary(status)).not.toMatch(/Semantic ranking is OFF/);
  });

  it('recovers on rebuild once the provider works again', async () => {
    let fail = true;
    const flaky: EmbeddingProvider = {
      name: 'local',
      embed: async (texts) => {
        if (fail) throw new Error('model download failed');
        return texts.map(() => [1, 0, 0]);
      },
    };
    const search = new SearchIndex({ embedder: flaky, configured: 'local', logger: silentLogger, store: makeStore() });
    await search.build(items);
    expect(search.embedderActive).toBe(false);

    fail = false;
    await search.build(items);
    expect(search.embedderActive).toBe(true);
    expect(search.buildStatus().embedder).toBe('local');
    expect(search.buildStatus().vectors).toBeGreaterThan(0);
  });
});

describe.each(STORES)('zotero_index status surfaces the degradation [%s]', (_name, makeStore) => {
  it('puts the cause in the summary a client actually reads', async () => {
    const search = keywordOnlyIndex(makeStore());
    await search.build(items);
    const res = await indexTool.handler({ action: 'status' }, { search } as any);
    expect(res.content[0].text).toMatch(/Semantic ranking is OFF/);
    expect(res.content[0].text).toMatch(/@huggingface\/transformers/);
    expect(res.structuredContent?.embedderActive).toBe(false);
    expect(res.structuredContent?.embedderConfigured).toBe('local');
  });
});

describe.each(STORES)('zotero_semantic_search with no vectors [%s]', (_name, makeStore) => {
  it('errors instead of returning an empty hit list for mode:"semantic"', async () => {
    const search = keywordOnlyIndex(makeStore());
    await search.build(items);
    const res = await semanticSearch.handler({ q: 'deep learning', mode: 'semantic' }, { search } as any);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/0 vectors/);
    expect(res.content[0].text).toMatch(/@huggingface\/transformers/);
    expect(res.structuredContent?.hits).toEqual([]);
    expect(res.structuredContent?.embedderActive).toBe(false);
  });

  it('still answers in auto mode, but says semantic ranking is off', async () => {
    const search = keywordOnlyIndex(makeStore());
    await search.build(items);
    const res = await semanticSearch.handler({ q: 'deep learning' }, { search } as any);

    expect(res.isError).toBeUndefined();
    expect((res.structuredContent?.hits as any[]).length).toBeGreaterThan(0);
    expect(res.content[0].text).toMatch(/Semantic ranking is OFF/);
    expect(res.structuredContent?.embedderActive).toBe(false);
  });

  it('leaves an explicit keyword search unannotated', async () => {
    const search = keywordOnlyIndex(makeStore());
    await search.build(items);
    const res = await semanticSearch.handler({ q: 'deep learning', mode: 'keyword' }, { search } as any);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).not.toMatch(/Semantic ranking is OFF/);
  });
});

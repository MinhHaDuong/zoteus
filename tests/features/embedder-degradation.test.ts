import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import { statusSummary } from '../../src/features/search/build.js';
import {
  createEmbeddingProvider,
  LocalEmbeddingProvider,
  missingTransformersHint,
  resolveTransformers,
  TRANSFORMERS_MODULE,
  type EmbeddingProvider,
} from '../../src/features/search/embeddings.js';
import { loadConfig } from '../../src/config.js';
import indexTool from '../../src/tools/index-tool.js';
import semanticSearch from '../../src/tools/semantic-search.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

const items = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Neural networks', abstractNote: 'deep learning' } },
  { key: 'B', data: { itemType: 'book', title: 'Gardening', abstractNote: 'tomatoes' } },
];

/** An index built while the local runtime is missing: keyword docs, zero vectors. */
function keywordOnlyIndex(): SearchIndex {
  return new MemorySearchIndex({
    embedder: null,
    configured: 'local',
    unavailable: missingTransformersHint({ dist: 'mcpb' }),
    logger: silentLogger,
  });
}

describe('resolveTransformers', () => {
  it('finds the package under a configured root, and from the package directory itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'zoteus-hf-'));
    const pkgDir = join(root, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: TRANSFORMERS_MODULE, main: 'index.js' }));
    writeFileSync(join(pkgDir, 'index.js'), 'export const pipeline = () => {};');

    // the directory that holds node_modules (what a standalone ~/.zoteus-deps looks like)
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

describe('status reports the effective embedder, not the configured one', () => {
  it('names the requested provider and the reason it is not running', async () => {
    const search = keywordOnlyIndex();
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
    const search = new MemorySearchIndex({ embedder: broken, configured: 'local', logger: silentLogger });
    await search.build(items);

    // The build still completes on keyword data, but it no longer claims to be embedding.
    expect(search.buildStatus().vectors).toBe(0);
    expect(search.embedderActive).toBe(false);
    expect(search.embedderName).toMatch(/none \(local requested; onnxruntime binding missing\)/);
    expect((await search.query('deep learning')).length).toBeGreaterThan(0);
  });

  it('says nothing extra when embeddings were switched off on purpose', async () => {
    const search = new MemorySearchIndex({ embedder: null, configured: 'off', logger: silentLogger });
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
    const search = new MemorySearchIndex({ embedder: flaky, configured: 'local', logger: silentLogger });
    await search.build(items);
    expect(search.embedderActive).toBe(false);

    fail = false;
    await search.build(items);
    expect(search.embedderActive).toBe(true);
    expect(search.buildStatus().embedder).toBe('local');
    expect(search.buildStatus().vectors).toBeGreaterThan(0);
  });
});

describe('zotero_index status surfaces the degradation', () => {
  it('puts the cause in the summary a client actually reads', async () => {
    const search = keywordOnlyIndex();
    await search.build(items);
    const res = await indexTool.handler({ action: 'status' }, { search } as any);
    expect(res.content[0].text).toMatch(/Semantic ranking is OFF/);
    expect(res.content[0].text).toMatch(/@huggingface\/transformers/);
    expect(res.structuredContent?.embedderActive).toBe(false);
    expect(res.structuredContent?.embedderConfigured).toBe('local');
  });
});

describe('zotero_semantic_search with no vectors', () => {
  it('errors instead of returning an empty hit list for mode:"semantic"', async () => {
    const search = keywordOnlyIndex();
    await search.build(items);
    const res = await semanticSearch.handler({ q: 'deep learning', mode: 'semantic' }, { search } as any);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/0 vectors/);
    expect(res.content[0].text).toMatch(/@huggingface\/transformers/);
    expect(res.structuredContent?.hits).toEqual([]);
    expect(res.structuredContent?.embedderActive).toBe(false);
  });

  it('still answers in auto mode, but says semantic ranking is off', async () => {
    const search = keywordOnlyIndex();
    await search.build(items);
    const res = await semanticSearch.handler({ q: 'deep learning' }, { search } as any);

    expect(res.isError).toBeUndefined();
    expect((res.structuredContent?.hits as any[]).length).toBeGreaterThan(0);
    expect(res.content[0].text).toMatch(/Semantic ranking is OFF/);
    expect(res.structuredContent?.embedderActive).toBe(false);
  });

  it('leaves an explicit keyword search unannotated', async () => {
    const search = keywordOnlyIndex();
    await search.build(items);
    const res = await semanticSearch.handler({ q: 'deep learning', mode: 'keyword' }, { search } as any);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).not.toMatch(/Semantic ranking is OFF/);
  });
});

describe('zotero_semantic_search with vectors but nothing to embed the query', () => {
  /**
   * The state an index reaches when it was built with an embedder and the server was then
   * restarted with ZOTEUS_EMBEDDINGS=off: the vectors are still on disk and are kept (they
   * are not known-wrong, only unusable), so `hasVectors` is true and the 0-vector refusal
   * does not fire. Semantic mode still cannot rank, because ranking needs the query
   * embedded too — and `embedderNotice` is deliberately silent about a provider that was
   * switched off on purpose, so nothing else explains the empty page either.
   */
  async function vectorsWithoutEmbedder(configured: string, unavailable?: string): Promise<SearchIndex> {
    const embedder: EmbeddingProvider = {
      name: 'openai',
      model: 'text-embedding-3-small',
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    };
    const built = new MemorySearchIndex({ embedder, configured: 'openai', logger: silentLogger });
    await built.build(items);
    // The provenance stamp is kept, not stripped: a server with no embedder of its own has
    // nothing to compare it against, so reconcileVectorProvenance leaves the rows alone and
    // vectorEmbedderId still names what produced them — which is what the message quotes.
    const saved = JSON.parse(JSON.stringify(built.toJSON()));

    const search = new MemorySearchIndex({ embedder: null, configured, unavailable, logger: silentLogger });
    search.loadFromJSON(saved);
    return search;
  }

  it('errors instead of answering "No matches" when embeddings are switched off', async () => {
    const search = await vectorsWithoutEmbedder('off');
    expect(search.hasVectors).toBe(true);
    expect(search.hasEmbedder).toBe(false);

    const res = await semanticSearch.handler({ q: 'deep learning', mode: 'semantic' }, { search } as any);

    // The whole point: an empty hit list here is indistinguishable from a library that
    // holds nothing on the subject, and no notice covers a deliberate `off`.
    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toMatch(/^No matches/);
    expect(res.content[0].text).toMatch(/ZOTEUS_EMBEDDINGS/);
    expect(res.content[0].text).toMatch(/mode:"keyword"/);
    // The index knows what produced the vectors it is still holding; the way back is to
    // that provider, not to any provider, so the message says which.
    expect(res.content[0].text).toContain('openai:text-embedding-3-small');
    expect(res.structuredContent?.hits).toEqual([]);
    expect(res.structuredContent?.embedderConfigured).toBe('off');
    expect(res.structuredContent?.embedderActive).toBe(false);
  });

  it('names the provider and its cause when one was configured but is not running', async () => {
    const search = await vectorsWithoutEmbedder('local', missingTransformersHint({ dist: 'mcpb' }));

    const res = await semanticSearch.handler({ q: 'deep learning', mode: 'semantic' }, { search } as any);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/@huggingface\/transformers/);
    expect(res.structuredContent?.embedderConfigured).toBe('local');
  });

  it('still answers in auto and keyword mode, which do not need the query embedded', async () => {
    const search = await vectorsWithoutEmbedder('off');

    for (const args of [{ q: 'deep learning' }, { q: 'deep learning', mode: 'keyword' as const }]) {
      const res = await semanticSearch.handler(args, { search } as any);
      expect(res.isError).toBeUndefined();
      expect((res.structuredContent?.hits as any[]).length).toBeGreaterThan(0);
    }
  });

  /**
   * The refusal must not fire on a provider that is merely *unhealthy*, and the two are
   * easy to conflate: `embedderActive` goes false on the first query-time failure and stays
   * false until the next build or update, because `noteEmbedFailure` records only the first
   * edge and nothing clears it on a later success. `query()` does not consult that flag —
   * it keys on the provider object — so it re-embeds and ranks again the moment the
   * provider recovers. A refusal keyed on the flag would convert one rate-limit blip into a
   * mode that stays dead until the user rebuilds the index, while `auto` went on embedding
   * the same query successfully.
   *
   * This test passes before the change as well as after: it is not the red step, it is the
   * guard on the one behaviour the fix could plausibly break, and nothing upstream pinned
   * it.
   */
  it('keeps ranking after a transient embedder failure, without an index rebuild', async () => {
    let failing = false;
    let embedCalls = 0;
    const flaky: EmbeddingProvider = {
      name: 'openai',
      model: 'text-embedding-3-small',
      embed: async (texts) => {
        embedCalls += 1;
        if (failing) throw new Error('429 rate limited');
        return texts.map(() => [1, 0, 0]);
      },
    };
    const search = new MemorySearchIndex({ embedder: flaky, configured: 'openai', logger: silentLogger });
    await search.build(items);

    failing = true;
    const during = await semanticSearch.handler({ q: 'deep learning', mode: 'semantic' }, { search } as any);
    // The failing query itself is not refused: the notice is what reports it, as before.
    expect(during.isError).toBeUndefined();
    expect(during.content[0].text).toMatch(/Semantic ranking is OFF/);
    expect(search.embedderActive).toBe(false); // and the flag is now stuck false

    failing = false;
    const before = embedCalls;
    const after = await semanticSearch.handler({ q: 'deep learning', mode: 'semantic' }, { search } as any);

    expect(after.isError).toBeUndefined();
    expect((after.structuredContent?.hits as any[]).length).toBeGreaterThan(0);
    // Ranked because the query was embedded again, not because a keyword ranker answered:
    // in mode:"semantic" the keyword side is closed, so a hit here can only be a vector hit.
    expect(embedCalls).toBe(before + 1);
  });
});

describe('local-embedding diagnostics name the path that was searched (#38)', () => {
  /** A directory that resolves nothing: the shape of a mistyped or stale settings value. */
  const emptyRoot = () => mkdtempSync(join(tmpdir(), 'zoteus-wrong-'));

  it('puts a configured ZOTEUS_TRANSFORMERS_PATH in the reason a client reads', () => {
    const dir = emptyRoot();
    const config = loadConfig({
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_TRANSFORMERS_PATH: dir,
      ZOTEUS_DIST: 'mcpb',
    } as any);
    const selection = createEmbeddingProvider(config, silentLogger);
    // Without the path, "not installed" is unfalsifiable: the value lives in a settings
    // pane, and the user has no way to see which directory the server actually tried.
    expect(selection.unavailable).toContain(dir);
  });

  it('logs that path too, for the installs that do have a stderr to read', () => {
    const dir = emptyRoot();
    const lines: string[] = [];
    const logger = { ...silentLogger, warn: (m: string) => lines.push(m) } as any;
    createEmbeddingProvider(
      loadConfig({ ZOTEUS_EMBEDDINGS: 'local', ZOTEUS_TRANSFORMERS_PATH: dir } as any),
      logger,
    );
    expect(lines.join('\n')).toContain(dir);
  });

  it('says nothing about a searched path when none was configured', () => {
    expect(missingTransformersHint({ dist: 'mcpb' })).not.toMatch(/ZOTEUS_TRANSFORMERS_PATH is set/);
  });

  it('names the file it loaded, the Node and the platform when the module throws on import', async () => {
    // The failure ZOTEUS_TRANSFORMERS_PATH actually produces once it points somewhere
    // plausible: onnxruntime's native binary was built for another Node ABI, so the
    // package resolves and then explodes on import. Naming the file that was loaded is
    // what separates "wrong path" from "right path, wrong build".
    const root = mkdtempSync(join(tmpdir(), 'zoteus-abi-'));
    const pkgDir = join(root, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: TRANSFORMERS_MODULE, type: 'module', main: 'index.js' }),
    );
    writeFileSync(join(pkgDir, 'index.js'), "throw new Error('NODE_MODULE_VERSION 115 vs 127');");

    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: root, dist: 'mcpb' });
    const err = await provider.embed(['anything']).then(
      () => new Error('expected the import to fail'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/resolved but failed to load/);
    expect(err.message).toContain(join(pkgDir, 'index.js'));
    expect(err.message).toContain(root);
    expect(err.message).toContain(process.version);
    expect(err.message).toContain(`${process.platform}-${process.arch}`);
  });
});

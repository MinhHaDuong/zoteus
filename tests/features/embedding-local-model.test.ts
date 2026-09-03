import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import {
  DEFAULT_LOCAL_MODEL,
  E5_PREFIXES,
  LocalEmbeddingProvider,
  createEmbeddingProvider,
  embedderIdentity,
  inputPrefixes,
  resolveTransformers,
} from '../../src/features/search/embeddings.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

/**
 * The local provider is the one nobody could point at another model (#43): the model id was
 * a constructor default nothing reached, and an E5 model without its `query: ` / `passage: `
 * prefixes silently retrieves worse. These tests pin both halves: which model the pipeline is
 * asked for, and what text each side of the search actually sends it.
 */

/** An extractor that records every batch it is handed, and returns unit vectors. */
function recordingExtractor(dim = 4): { calls: string[][]; extractor: (input: string | string[]) => Promise<any> } {
  const calls: string[][] = [];
  return {
    calls,
    extractor: async (input: string | string[]) => {
      const batch = Array.isArray(input) ? input : [input];
      calls.push(batch);
      return { data: new Float32Array(batch.length * dim).fill(0.5), dims: [batch.length, dim] };
    },
  };
}

describe('which model the local provider loads', () => {
  it('defaults to the historical MiniLM', () => {
    expect(new LocalEmbeddingProvider().model).toBe(DEFAULT_LOCAL_MODEL);
    expect(DEFAULT_LOCAL_MODEL).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('keeps the model id inside the embedder identity, which is what the stale-vector guard compares', () => {
    const provider = new LocalEmbeddingProvider('Xenova/multilingual-e5-small');
    expect(embedderIdentity(provider)).toBe('local:Xenova/multilingual-e5-small');
    expect(embedderIdentity(new LocalEmbeddingProvider())).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
  });
});

describe('E5 input prefixes', () => {
  it('recognises E5 model ids as a path or word segment, and nothing else', () => {
    for (const id of [
      'Xenova/multilingual-e5-small',
      'intfloat/e5-base-v2',
      'intfloat/multilingual-e5-large-instruct',
      'E5',
      'Xenova/e5-small',
    ]) {
      expect(inputPrefixes(id), id).toEqual(E5_PREFIXES);
    }
    for (const id of [
      'Xenova/all-MiniLM-L6-v2',
      'sentence-transformers/sentence-t5-base',
      'Xenova/bge-m3',
      'Xenova/gte-small',
      'text-embedding-3-small',
    ]) {
      expect(inputPrefixes(id), id).toBeNull();
    }
  });

  it('honours the explicit override in both directions', () => {
    expect(inputPrefixes('Xenova/multilingual-e5-small', 'off')).toBeNull();
    expect(inputPrefixes('some-org/private-mirror-of-e-five', 'e5')).toEqual(E5_PREFIXES);
  });

  it('prefixes queries and passages differently, and leaves the caller’s text alone', async () => {
    const { calls, extractor } = recordingExtractor();
    const provider = new LocalEmbeddingProvider('Xenova/multilingual-e5-small', async () => extractor);

    const texts = ['Wärmepumpen im Altbau'];
    await provider.embed(texts, 'query');
    await provider.embed(texts, 'passage');
    await provider.embed(texts); // passages are the default: every existing caller builds an index

    expect(calls).toEqual([
      ['query: Wärmepumpen im Altbau'],
      ['passage: Wärmepumpen im Altbau'],
      ['passage: Wärmepumpen im Altbau'],
    ]);
    expect(texts).toEqual(['Wärmepumpen im Altbau']);
  });

  it('sends a non-E5 model exactly what it was given', async () => {
    const { calls, extractor } = recordingExtractor();
    const provider = new LocalEmbeddingProvider(DEFAULT_LOCAL_MODEL, async () => extractor);
    await provider.embed(['a query'], 'query');
    await provider.embed(['a passage'], 'passage');
    expect(calls).toEqual([['a query'], ['a passage']]);
  });

  it('never stores the prefix with the passage', async () => {
    const { calls, extractor } = recordingExtractor();
    const embedder = new LocalEmbeddingProvider('Xenova/multilingual-e5-small', async () => extractor);
    const search = new MemorySearchIndex({ embedder, logger: silentLogger });
    await search.build([
      { key: 'K1', data: { itemType: 'journalArticle', title: 'Wärmepumpen', abstractNote: 'Heizen im Altbau' } },
    ] as any);
    const hits = await search.query('Wärmepumpen', { limit: 1 });

    // The build embedded passages, the search embedded a query, and the passage the index
    // kept is the one the caller handed it.
    expect(calls.some((b) => b.every((t) => t.startsWith('passage: ')))).toBe(true);
    expect(calls.some((b) => b.every((t) => t.startsWith('query: ')))).toBe(true);
    expect(JSON.stringify(search.toJSON())).not.toContain('passage: ');
    expect(hits[0]?.itemKey).toBe('K1');
  });
});

describe('configuration', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'zoteus-local-model-'));
    const pkg = join(root, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
    writeFileSync(
      join(pkg, 'index.cjs'),
      `const env = { cacheDir: '/stub/default/.cache' };
const loaded = [];
async function pipeline(task, model) {
  loaded.push({ task, model, cacheDir: env.cacheDir });
  return async (input) => {
    const batch = Array.isArray(input) ? input : [input];
    return { data: new Float32Array(batch.length * 2).fill(0.5), dims: [batch.length, 2] };
  };
}
module.exports = { env, pipeline, loaded };
`,
    );
    expect(resolveTransformers(root)).not.toBeNull();
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  let stub: any;
  beforeEach(async () => {
    const mod = await import(resolveTransformers(root)!);
    stub = mod.default ?? mod;
    stub.loaded.length = 0;
  });

  const config = (env: Record<string, string>) =>
    loadConfig({ ZOTEUS_EMBEDDINGS: 'local', ZOTEUS_TRANSFORMERS_PATH: root, ...env } as any);

  it('lets ZOTEUS_EMBEDDING_MODEL pick the local model', async () => {
    const dataDir = join(root, 'data');
    const { provider } = createEmbeddingProvider(
      config({ ZOTEUS_EMBEDDING_MODEL: ' Xenova/multilingual-e5-small ', ZOTEUS_DATA_DIR: dataDir }),
      silentLogger,
    );
    expect(provider?.model).toBe('Xenova/multilingual-e5-small');

    await provider!.embed(['ein Absatz']);
    // The org-prefixed id reaches the pipeline whole, and the weights still land under the
    // data directory rather than inside the package (#27).
    expect(stub.loaded).toEqual([
      { task: 'feature-extraction', model: 'Xenova/multilingual-e5-small', cacheDir: join(dataDir, 'models') },
    ]);
  });

  it('keeps MiniLM when nothing is configured', () => {
    expect(createEmbeddingProvider(config({}), silentLogger).provider?.model).toBe(DEFAULT_LOCAL_MODEL);
  });

  it('reads ZOTEUS_EMBEDDING_PREFIXES, and falls back to auto when it is not a value', () => {
    expect(loadConfig({} as any).embeddingPrefixes).toBe('auto');
    expect(loadConfig({ ZOTEUS_EMBEDDING_PREFIXES: 'off' } as any).embeddingPrefixes).toBe('off');
    const bad = loadConfig({ ZOTEUS_EMBEDDING_PREFIXES: 'yes please' } as any);
    expect(bad.embeddingPrefixes).toBe('auto');
    expect(bad.warnings.join(' ')).toContain('ZOTEUS_EMBEDDING_PREFIXES');
  });

  it('turns the prefixes off through configuration', async () => {
    const { provider } = createEmbeddingProvider(
      config({ ZOTEUS_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small', ZOTEUS_EMBEDDING_PREFIXES: 'off' }),
      silentLogger,
    );
    const { calls, extractor } = recordingExtractor();
    const bare = new LocalEmbeddingProvider(provider!.model!, async () => extractor, { prefixes: 'off' });
    await bare.embed(['q'], 'query');
    expect(calls).toEqual([['q']]);
  });

  it('says so rather than ignoring a ZOTEUS_LOCAL_EMBEDDING_MODEL that does nothing', () => {
    const cfg = loadConfig({ ZOTEUS_LOCAL_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small' } as any);
    expect(cfg.warnings.join(' ')).toContain('ZOTEUS_LOCAL_EMBEDDING_MODEL');
    expect(cfg.warnings.join(' ')).toContain('ZOTEUS_EMBEDDING_MODEL');
    // An unexpanded desktop marker is not a setting anybody wrote.
    expect(loadConfig({ ZOTEUS_LOCAL_EMBEDDING_MODEL: '' } as any).warnings).toEqual([]);
  });
});

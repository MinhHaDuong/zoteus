import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import {
  ApiEmbeddingProvider,
  DEFAULT_API_MODELS,
  LocalEmbeddingProvider,
  batchPause,
  createEmbeddingProvider,
  type EmbeddingProvider,
} from '../../src/features/search/embeddings.js';
import { INCUMBENT_LOCAL_ENTRY } from '../../src/features/search/embedder-registry.js';
import { DEFAULT_EMBED_BATCH_SIZE } from '../../src/features/search/limits.js';
import {
  startIndexBuild,
  staleVectorsNotice,
  statusSummary,
} from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import semanticSearch from '../../src/tools/semantic-search.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** Stub fetch with a minimal OpenAI/Gemini embeddings endpoint, recording every request. */
function captureEmbeddingRequests(): Captured[] {
  const calls: Captured[] = [];
  const stub = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const json = url.includes('openai')
      ? { data: (body.input as string[]).map(() => ({ embedding: [1, 0, 0] })) }
      : { embeddings: (body.requests as unknown[]).map(() => ({ values: [1, 0, 0] })) };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  vi.stubGlobal('fetch', stub);
  return calls;
}

/** An embedder that records the batches it is handed, so batching itself is observable. */
function recordingEmbedder(
  name = 'recorder',
  model?: string,
): EmbeddingProvider & { batches: string[][] } {
  const batches: string[][] = [];
  return {
    name,
    model,
    batches,
    embed: async (texts: string[]) => {
      batches.push(texts);
      return texts.map(() => [1, 0, 0]);
    },
  };
}

function makeLibrary(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: {
      itemType: 'journalArticle',
      title: `Item ${i}`,
      abstractNote: `abstract body number ${i}`,
    },
  }));
}

function pager(library: any[], pageSize = 100) {
  return async (start: number) => ({
    items: library.slice(start, start + pageSize),
    totalResults: library.length,
  });
}

/** Minimal context for the fire-and-forget build path (router + config + index). */
function ctxFor(index: SearchIndex, library: any[], env: Record<string, string> = {}): any {
  const page = pager(library);
  return {
    config: loadConfig(env as any),
    search: index,
    logger: silentLogger,
    router: {
      servesLocally: () => false,
      searchItems: async ({ start }: { start: number }) => {
        const p = await page(start);
        return { data: p.items, totalResults: p.totalResults };
      },
    },
  };
}

/** startIndexBuild returns immediately by contract; wait for the background job. */
async function settle(index: SearchIndex): Promise<void> {
  for (let i = 0; i < 500 && index.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('embedding knobs are runtime parameters', () => {
  it('defaults leave every provider exactly as it was', () => {
    const cfg = loadConfig({} as any);
    expect(cfg.embeddingModel).toBeUndefined();
    expect(cfg.embedBatchSize).toBeUndefined();
    expect(cfg.embedBatchDelayMs).toBe(0);
    expect(DEFAULT_EMBED_BATCH_SIZE).toBe(32);
    expect(LocalEmbeddingProvider.BATCH_SIZE).toBe(DEFAULT_EMBED_BATCH_SIZE);
  });

  it('reads the three variables from the environment', () => {
    const cfg = loadConfig({
      ZOTEUS_EMBEDDING_MODEL: ' text-embedding-3-large ',
      ZOTEUS_EMBED_BATCH_SIZE: '8',
      ZOTEUS_EMBED_BATCH_DELAY_MS: '250',
    } as any);
    expect(cfg.embeddingModel).toBe('text-embedding-3-large');
    expect(cfg.embedBatchSize).toBe(8);
    expect(cfg.embedBatchDelayMs).toBe(250);
  });

  it('treats an empty model as unset rather than as an empty model name', () => {
    expect(loadConfig({ ZOTEUS_EMBEDDING_MODEL: '' } as any).embeddingModel).toBeUndefined();
  });

  it('refuses a batch size that could never produce a request, without refusing to boot', () => {
    // Never the configured value, and never a dead server either (#18): the knob is
    // reported and left unset, which is the provider's own batch size.
    for (const bad of ['0', '-4', 'lots']) {
      const cfg = loadConfig({ ZOTEUS_EMBED_BATCH_SIZE: bad } as any);
      expect(cfg.embedBatchSize).toBeUndefined();
      expect(cfg.warnings).toEqual([`ZOTEUS_EMBED_BATCH_SIZE="${bad}" is not usable, ignoring it`]);
    }
  });

  it('refuses a negative delay but accepts 0', () => {
    const cfg = loadConfig({ ZOTEUS_EMBED_BATCH_DELAY_MS: '-1' } as any);
    expect(cfg.embedBatchDelayMs).toBe(0);
    expect(cfg.warnings).toEqual(['ZOTEUS_EMBED_BATCH_DELAY_MS="-1" is not usable, using 0']);
    expect(loadConfig({ ZOTEUS_EMBED_BATCH_DELAY_MS: '0' } as any).embedBatchDelayMs).toBe(0);
  });
});

describe('the API providers embed with the configured model', () => {
  it('keeps text-embedding-3-small as the OpenAI default', async () => {
    const calls = captureEmbeddingRequests();
    const provider = new ApiEmbeddingProvider('openai', 'key');
    expect(provider.model).toBe(DEFAULT_API_MODELS.openai);
    await provider.embed(['a']);
    expect(calls[0]!.body.model).toBe('text-embedding-3-small');
  });

  it('sends the configured OpenAI model instead', async () => {
    const calls = captureEmbeddingRequests();
    const provider = new ApiEmbeddingProvider('openai', 'key', { model: 'text-embedding-3-large' });
    await provider.embed(['a']);
    expect(calls[0]!.body.model).toBe('text-embedding-3-large');
    expect(provider.model).toBe('text-embedding-3-large');
  });

  it('puts the Gemini model in both the URL and the request bodies', async () => {
    const calls = captureEmbeddingRequests();
    await new ApiEmbeddingProvider('gemini', 'key').embed(['a']);
    expect(calls[0]!.url).toContain(`models/${DEFAULT_API_MODELS.gemini}:batchEmbedContents`);
    expect(calls[0]!.body.requests[0].model).toBe(`models/${DEFAULT_API_MODELS.gemini}`);

    calls.length = 0;
    await new ApiEmbeddingProvider('gemini', 'key', { model: 'gemini-embedding-001' }).embed(['a']);
    expect(calls[0]!.url).toContain('models/gemini-embedding-001:batchEmbedContents');
    expect(calls[0]!.body.requests[0].model).toBe('models/gemini-embedding-001');
  });

  it("accepts a Gemini model written with Google's models/ prefix", async () => {
    const calls = captureEmbeddingRequests();
    const provider = new ApiEmbeddingProvider('gemini', 'key', {
      model: 'models/gemini-embedding-001',
    });
    await provider.embed(['a']);
    expect(provider.model).toBe('gemini-embedding-001'); // identity is the bare name
    expect(calls[0]!.url).not.toContain('models/models/');
    expect(calls[0]!.body.requests[0].model).toBe('models/gemini-embedding-001');
  });

  it('wires ZOTEUS_EMBEDDING_MODEL through to the active provider', () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'key';
    try {
      const config = loadConfig({
        ZOTEUS_EMBEDDINGS: 'openai',
        ZOTEUS_EMBEDDING_MODEL: 'text-embedding-3-large',
      } as any);
      expect(createEmbeddingProvider(config, silentLogger).provider?.model).toBe(
        'text-embedding-3-large',
      );
      // Unset means the provider's own default, not an empty model name.
      const bare = loadConfig({ ZOTEUS_EMBEDDINGS: 'openai' } as any);
      expect(createEmbeddingProvider(bare, silentLogger).provider?.model).toBe(
        DEFAULT_API_MODELS.openai,
      );
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

describe('the API key travels in a header, never in the URL', () => {
  // A URL is the part of a request that gets logged — by proxies, by error causes, by
  // anything that prints which endpoint failed — so no request may carry the key there.
  it('sends the Gemini key as x-goog-api-key', async () => {
    const calls = captureEmbeddingRequests();
    await new ApiEmbeddingProvider('gemini', 'g-secret').embed(['a']);
    expect(calls[0]!.headers['x-goog-api-key']).toBe('g-secret');
  });

  it('sends the OpenAI key as a bearer token', async () => {
    const calls = captureEmbeddingRequests();
    await new ApiEmbeddingProvider('openai', 'o-secret').embed(['a']);
    expect(calls[0]!.headers['authorization']).toBe('Bearer o-secret');
  });

  it('puts the key in no URL, for either provider', async () => {
    const calls = captureEmbeddingRequests();
    await new ApiEmbeddingProvider('gemini', 'g-secret', { batchSize: 1 }).embed(['a', 'b']);
    await new ApiEmbeddingProvider('openai', 'o-secret').embed(['a']);
    for (const { url } of calls) {
      expect(url).not.toContain('g-secret');
      expect(url).not.toContain('o-secret');
      expect(url).not.toContain('key=');
    }
  });
});

describe('passages per embedding request', () => {
  it('sends one request per batch when a batch size is configured', async () => {
    const calls = captureEmbeddingRequests();
    const texts = Array.from({ length: 7 }, (_, i) => `passage ${i}`);
    const vecs = await new ApiEmbeddingProvider('openai', 'key', { batchSize: 3 }).embed(texts);

    expect(calls.map((c) => c.body.input.length)).toEqual([3, 3, 1]);
    expect(vecs).toHaveLength(7); // same count in, same count out
  });

  it('sends the texts it is given in one request when unset (unchanged behaviour)', async () => {
    const calls = captureEmbeddingRequests();
    await new ApiEmbeddingProvider('openai', 'key').embed(
      Array.from({ length: 7 }, (_, i) => `p${i}`),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.input).toHaveLength(7);
  });

  it('batches the local pipeline by the configured size too', async () => {
    const batches: string[][] = [];
    const dim = 4;
    const extractor = async (input: string | string[]) => {
      const batch = Array.isArray(input) ? input : [input];
      batches.push(batch);
      return { data: new Float32Array(batch.length * dim).fill(0.5), dims: [batch.length, dim] };
    };
    (extractor as any).tokenizer = { model_max_length: 512 };
    const provider = new LocalEmbeddingProvider(
      { ...INCUMBENT_LOCAL_ENTRY, model: 'test-model', dimension: dim },
      async () => extractor,
      { batchSize: 10 },
    );
    const vecs = await provider.embed(Array.from({ length: 25 }, (_, i) => `passage ${i}`));

    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(vecs).toHaveLength(25);
  });

  it('caps the build at the batch size the build was given', async () => {
    const embedder = recordingEmbedder();
    const search = new MemorySearchIndex({ embedder, logger: silentLogger });
    await search.buildIncremental(pager(makeLibrary(40), 20), { embedBatchSize: 4 });

    expect(embedder.batches.length).toBeGreaterThan(1);
    expect(Math.max(...embedder.batches.map((b) => b.length))).toBe(4);
  });

  it('keeps the historical batch size when nothing is configured', async () => {
    const embedder = recordingEmbedder();
    const search = new MemorySearchIndex({ embedder, logger: silentLogger });
    await search.buildIncremental(pager(makeLibrary(100), 100));

    expect(Math.max(...embedder.batches.map((b) => b.length))).toBe(DEFAULT_EMBED_BATCH_SIZE);
  });

  it('takes ZOTEUS_EMBED_BATCH_SIZE through startIndexBuild', async () => {
    const embedder = recordingEmbedder();
    const search = new MemorySearchIndex({ embedder, logger: silentLogger });
    startIndexBuild(ctxFor(search, makeLibrary(60), { ZOTEUS_EMBED_BATCH_SIZE: '5' }));
    await settle(search);

    expect(embedder.batches.length).toBeGreaterThan(1);
    expect(Math.max(...embedder.batches.map((b) => b.length))).toBe(5);
  });
});

describe('the pause between embedding batches', () => {
  /** Replace setTimeout with an immediate one that records the delays it was asked for. */
  function recordDelays(): number[] {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return setImmediate(fn) as unknown as NodeJS.Timeout;
    }) as any);
    return delays;
  }

  it('only yields at 0, so the default schedules no timer at all', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    await batchPause(0);
    await batchPause();
    expect(timer).not.toHaveBeenCalled();
  });

  it('sleeps for a positive delay', async () => {
    const delays = recordDelays();
    await batchPause(250);
    expect(delays).toContain(250);
  });

  it('paces the build with ZOTEUS_EMBED_BATCH_DELAY_MS', async () => {
    const delays = recordDelays();
    const embedder = recordingEmbedder();
    const search = new MemorySearchIndex({ embedder, logger: silentLogger });
    startIndexBuild(
      ctxFor(search, makeLibrary(40), {
        ZOTEUS_EMBED_BATCH_SIZE: '4',
        ZOTEUS_EMBED_BATCH_DELAY_MS: '37',
      }),
    );
    await settle(search);

    // One pause per embedded batch, so the request rate is bounded by the delay.
    expect(delays.filter((d) => d === 37).length).toBeGreaterThanOrEqual(
      embedder.batches.length - 1,
    );
  });

  it('paces an API provider between its own requests', async () => {
    const delays = recordDelays();
    captureEmbeddingRequests();
    await new ApiEmbeddingProvider('openai', 'key', { batchSize: 2, batchDelayMs: 42 }).embed([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(delays.filter((d) => d === 42)).toHaveLength(1); // between the two requests, not after the last
  });
});

describe('vectors built with another model are not queried with this one', () => {
  const items = [
    {
      key: 'A',
      data: { itemType: 'journalArticle', title: 'Neural networks', abstractNote: 'deep learning' },
    },
    { key: 'B', data: { itemType: 'book', title: 'Gardening', abstractNote: 'tomatoes' } },
  ];

  /** An index built by `model`, serialized exactly as it would be persisted. */
  async function builtWith(model: string): Promise<any> {
    const search = new MemorySearchIndex({
      embedder: recordingEmbedder('openai', model),
      configured: 'openai',
    });
    await search.build(items);
    return JSON.parse(JSON.stringify(search.toJSON()));
  }

  function indexUsing(model: string): SearchIndex {
    return new MemorySearchIndex({
      embedder: recordingEmbedder('openai', model),
      configured: 'openai',
      logger: silentLogger,
    });
  }

  it('persists the embedder identity with the vectors', async () => {
    const saved = await builtWith('text-embedding-3-small');
    expect(saved.embedderId).toBe('openai:text-embedding-3-small');
    expect(saved.vectors.length).toBeGreaterThan(0);
  });

  it('discards them on load, and says which model to rebuild with', async () => {
    const saved = await builtWith('text-embedding-3-small');
    const search = indexUsing('text-embedding-3-large');
    search.loadFromJSON(saved);
    const s = search.buildStatus();

    expect(s.vectors).toBe(0);
    expect(s.embedderModel).toBe('text-embedding-3-large');
    expect(s.vectorsStaleReason).toContain('openai:text-embedding-3-small');
    expect(s.vectorsStaleReason).toContain('openai:text-embedding-3-large');
    expect(staleVectorsNotice(s)).toContain('not comparable');
    expect(statusSummary(s)).toContain('re-embed');
    // The passages themselves are model-independent, so keyword search is untouched.
    expect(s.documents).toBeGreaterThan(0);
    expect((await search.query('deep learning', { mode: 'keyword' })).length).toBeGreaterThan(0);
  });

  it('keeps them when the same model is still in force', async () => {
    const saved = await builtWith('text-embedding-3-small');
    const search = indexUsing('text-embedding-3-small');
    search.loadFromJSON(saved);

    expect(search.buildStatus().vectors).toBe(saved.vectors.length);
    expect(search.buildStatus().vectorsStaleReason).toBeUndefined();
  });

  it('keeps them for an index file written before the identity was persisted', async () => {
    const saved = await builtWith('text-embedding-3-small');
    delete saved.embedderId; // provenance unknown, not known-wrong
    const search = indexUsing('text-embedding-3-large');
    search.loadFromJSON(saved);

    expect(search.buildStatus().vectors).toBe(saved.vectors.length);
    expect(search.buildStatus().vectorsStaleReason).toBeUndefined();
  });

  it('stays silent with no active embedder, which never queries them anyway', async () => {
    const saved = await builtWith('text-embedding-3-small');
    const search = new MemorySearchIndex({
      embedder: null,
      configured: 'off',
      logger: silentLogger,
    });
    search.loadFromJSON(saved);

    expect(search.buildStatus().vectors).toBe(saved.vectors.length);
    expect(search.buildStatus().vectorsStaleReason).toBeUndefined();
  });

  it('clears the verdict once the index is rebuilt with the current model', async () => {
    const saved = await builtWith('text-embedding-3-small');
    const search = indexUsing('text-embedding-3-large');
    search.loadFromJSON(saved);
    expect(search.buildStatus().vectorsStaleReason).toBeDefined();

    await search.build(items);
    const s = search.buildStatus();
    expect(s.vectorsStaleReason).toBeUndefined();
    expect(s.vectors).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(search.toJSON())).embedderId).toBe(
      'openai:text-embedding-3-large',
    );
  });

  it('catches a switch under a legacy index file at query time, by vector width', async () => {
    const saved = await builtWith('text-embedding-3-small');
    delete saved.embedderId; // written before the identity was recorded
    const wider: EmbeddingProvider = {
      name: 'openai',
      model: 'text-embedding-3-large',
      embed: async (texts) => texts.map(() => [1, 0, 0, 0, 0]),
    };
    const search = new MemorySearchIndex({
      embedder: wider,
      configured: 'openai',
      logger: silentLogger,
    });
    search.loadFromJSON(saved);
    expect(search.buildStatus().vectors).toBeGreaterThan(0); // provenance unknown so far

    // Ranking 3-dimensional vectors against a 5-dimensional query returns plausible
    // nonsense rather than an error, so the query itself has to notice.
    const hits = await search.query('deep learning');
    expect(hits.length).toBeGreaterThan(0); // keyword ranking still answers
    const s = search.buildStatus();
    expect(s.vectors).toBe(0);
    expect(s.vectorsStaleReason).toContain('dimensions');
    expect(statusSummary(s)).toContain('re-embed');
  });

  it('tells a semantic-only search why the index lost its vectors', async () => {
    const saved = await builtWith('text-embedding-3-small');
    const search = indexUsing('text-embedding-3-large');
    search.loadFromJSON(saved);

    const res = await semanticSearch.handler({ q: 'deep learning', mode: 'semantic' }, {
      search,
    } as any);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('re-embed');

    const auto = await semanticSearch.handler({ q: 'deep learning' }, { search } as any);
    expect(auto.isError).toBeUndefined();
    expect(auto.content[0].text).toContain('discarded');
  });
});

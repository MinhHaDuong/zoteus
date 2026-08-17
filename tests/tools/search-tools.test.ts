import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import indexTool from '../../src/tools/index-tool.js';
import semanticSearch from '../../src/tools/semantic-search.js';
import { SearchIndex } from '../../src/features/search/index-manager.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';

const sampleItems = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Neural networks', abstractNote: 'deep learning' } },
  { key: 'B', data: { itemType: 'book', title: 'Gardening', abstractNote: 'tomatoes' } },
];

function makeCtx(search: SearchIndex): any {
  return {
    config: { dataDir: join(tmpdir(), `zoteus-idx-${process.pid}`) },
    router: { defaultLibrary: () => ({ type: 'user', id: 19552201 }) },
    web: {
      listItems: vi.fn(async () => ({ data: sampleItems, totalResults: 2, lastModifiedVersion: 1 })),
    },
    search,
    searchIndexPath: join(tmpdir(), `zoteus-idx-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

/** Poll the status action until the background build leaves the "building" state. */
async function pollUntilSettled(ctx: any, attempts = 100): Promise<any> {
  let status;
  for (let i = 0; i < attempts; i++) {
    status = await indexTool.handler({ action: 'status' }, ctx);
    if (status.structuredContent?.state !== 'building') return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return status;
}

describe('zotero_index', () => {
  it('builds the index from the library and reports status', async () => {
    const search = new SearchIndex({ embedder: new FakeEmbeddingProvider() });
    const ctx = makeCtx(search);
    const res = await indexTool.handler({ action: 'build' }, ctx);
    expect(ctx.web.listItems).toHaveBeenCalled();
    // build is asynchronous now: it starts a background job and returns immediately.
    expect(res.structuredContent?.state).toBe('building');
    const status = await pollUntilSettled(ctx);
    expect(status.structuredContent?.state).toBe('done');
    expect(status.structuredContent?.items).toBe(2);
  });
});

describe('zotero_semantic_search', () => {
  it('errors when the index is empty', async () => {
    const res = await semanticSearch.handler({ q: 'anything' }, makeCtx(new SearchIndex({ embedder: null })));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/build/i);
  });

  it('returns ranked hits once built', async () => {
    const search = new SearchIndex({ embedder: new FakeEmbeddingProvider() });
    await search.build(sampleItems);
    const res = await semanticSearch.handler({ q: 'deep learning', limit: 1 }, makeCtx(search));
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent?.hits as any[])[0].itemKey).toBe('A');
  });
});

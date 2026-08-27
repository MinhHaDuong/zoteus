import { describe, it, expect } from 'vitest';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { progressLine, statusSummary } from '../../src/features/search/build.js';
import type { IndexBuildStatus } from '../../src/features/search/backend.js';

/**
 * A build used to walk the library once, indexing each item's metadata and then crawling
 * its attachments before moving on. So on a large library nothing was searchable until the
 * full-text crawl had finished, and that crawl can run for days (#23). Metadata for the
 * whole library now lands first, in its own pass.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const BODY = 'The ablation removes the recurrent gate entirely. '.repeat(30);

const makeLibrary = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
  }));

const pager = (library: any[], version?: number) => async (start: number) => ({
  items: library.slice(start, start + 100),
  totalResults: library.length,
  ...(version ? { lastModifiedVersion: version } : {}),
});

describe('a build indexes all metadata before any full text', () => {
  it('has every item searchable on its metadata before the first body is fetched', async () => {
    const library = makeLibrary(250);
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    let itemsWhenFirstBodyAsked = -1;

    await search.buildIncremental(pager(library), {
      fulltextFor: async () => {
        // Sampled on the first body request: whatever this is, it is what a user querying
        // at that moment would be able to find.
        if (itemsWhenFirstBodyAsked < 0) itemsWhenFirstBodyAsked = search.buildStatus().items;
        return BODY;
      },
    });

    expect(itemsWhenFirstBodyAsked).toBe(250);
    expect((await search.query('topic249')).length).toBeGreaterThan(0);
  });

  it('reports the phase, and says the library is already searchable during the second', async () => {
    const seen: IndexBuildStatus[] = [];
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await search.buildIncremental(pager(makeLibrary(120)), {
      fulltextFor: async () => BODY,
      onProgress: (s) => seen.push({ ...s }),
      progressEveryItems: 1,
    });

    expect(seen.some((s) => s.phase === 'metadata')).toBe(true);
    const inFulltext = seen.find((s) => s.phase === 'fulltext' && s.state === 'building');
    expect(inFulltext).toBeTruthy();
    expect(inFulltext!.fulltextItemsTotal).toBe(120);
    expect(statusSummary(inFulltext!)).toMatch(/already indexed and searchable/);
  });

  it('skips items the source cannot serve rather than asking about each one', async () => {
    const asked: string[] = [];
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await search.buildIncremental(pager(makeLibrary(50)), {
      fulltextFor: async (key) => {
        asked.push(key);
        return BODY;
      },
      fulltextKeys: async () => new Set(['K7', 'K20']),
    });
    expect(asked.sort()).toEqual(['K20', 'K7']);
    expect(search.buildStatus().fulltextItems).toBe(2);
  });

  it('never stamps the library version until the full-text pass has finished too', async () => {
    // The trap. A stamp written after the metadata pass would make a build interrupted
    // partway through a days-long body crawl look complete: the next action:"update" finds
    // a valid stamp and runs a `?since=V` delta, and the items whose attachments were never
    // crawled are unchanged in Zotero, so they appear in no delta, ever. Their body text
    // would be missing permanently and nothing would report it.
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    let stampAtFulltextStart = -1;
    const final = await search.buildIncremental(pager(makeLibrary(30), 4242), {
      fulltextFor: async () => {
        if (stampAtFulltextStart < 0) stampAtFulltextStart = search.buildStatus().libraryVersion;
        return BODY;
      },
      versionBackend: 'local',
    });
    expect(stampAtFulltextStart).toBe(0);
    expect(final.libraryVersion).toBe(4242);
  });

  it('withholds the stamp when the full-text pass is stopped part way', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(30), 4242), {
      fulltextFor: async (key) => {
        if (key === 'K5') search.requestStop();
        return BODY;
      },
      versionBackend: 'local',
    });
    // Metadata is complete and kept; the stamp is not written, so the next update rebuilds
    // rather than trusting a body crawl that never ran.
    expect(final.items).toBe(30);
    expect(final.libraryVersion).toBe(0);
    expect(search.updateBlocker('local')).toMatch(/no library version stamp/);
  });

  it('withholds the stamp when the whole full-text pass could not read anything', async () => {
    // The desktop app quits after the metadata pass. Every body read then fails, and each
    // one is caught per item so the pass still reaches its end — so without this the build
    // would report done, stamp itself current, and be permanently missing its body text:
    // the items it never read are unchanged in Zotero and appear in no future delta.
    let failures = 0;
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(20), 900), {
      fulltextFor: async () => {
        failures++;
        return undefined;
      },
      fulltextFailures: () => failures,
      versionBackend: 'local',
    });
    expect(final.libraryVersion).toBe(0);
    expect(final.fulltextReason).toMatch(/could not be read/);
    expect(search.updateBlocker('local')).toMatch(/no library version stamp/);
  });

  it('keeps the stamp when only some items could not be read, and says so', async () => {
    let failures = 0;
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(20), 900), {
      fulltextFor: async (key) => {
        if (key === 'K3') { failures++; return undefined; }
        return BODY;
      },
      fulltextFailures: () => failures,
      versionBackend: 'local',
    });
    expect(final.libraryVersion).toBe(900);
    expect(final.fulltextReason).toMatch(/1 of 20 item\(s\) could not be read/);
  });

  it('does not carry a build\'s phase into a later update', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await search.buildIncremental(pager(makeLibrary(5), 100), { fulltextFor: async () => BODY, versionBackend: 'local' });
    expect(search.buildStatus().phase).toBe('fulltext');
    const after = await search.updateIncremental({
      backend: 'local',
      fetchChanged: async () => ({ items: [], totalResults: 0 }),
      liveKeys: async () => new Set(makeLibrary(5).map((i) => i.key)),
    });
    // An update has no two-pass structure; reporting one would claim it was only adding
    // body text while it re-chunks and re-embeds the metadata of every changed item.
    expect(after.phase).toBe('metadata');
  });

  it('leaves a build without full text byte-identical in its progress line', async () => {
    // The metadata-only path is the common one and must not have changed at all.
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(5)));
    expect(final.phase).toBe('metadata');
    expect(progressLine(final)).toBe('5 of 5 items indexed, 5 passages, 0 vectors (embedder=none (keyword-only))');
  });

  it('does not advertise "full text of 0 items" while it is still on the metadata pass', async () => {
    // Beside a climbing item count that reads as a full-text crawl that has stalled,
    // rather than one that has not begun.
    const seen: IndexBuildStatus[] = [];
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await search.buildIncremental(pager(makeLibrary(120)), {
      fulltextFor: async () => BODY,
      onProgress: (s) => seen.push({ ...s }),
      progressEveryItems: 1,
    });
    const duringMetadata = seen.filter((s) => s.phase === 'metadata' && s.state === 'building');
    expect(duringMetadata.length).toBeGreaterThan(0);
    for (const s of duringMetadata) expect(progressLine(s)).not.toMatch(/full text of/);
  });
});

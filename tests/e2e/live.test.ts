import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import getFulltext from '../../src/tools/get-fulltext.js';

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

  it('exercises groups, export, and sync delta (read-only)', async () => {
    const config = loadConfig(process.env);
    const { ctx } = await buildServer(config);
    const lib = ctx.router.defaultLibrary();

    // groups (may be empty, but must not error)
    const groups = await ctx.web.listGroups(ctx.router.whoami()!.userID);
    expect(Array.isArray(groups.data)).toBe(true);

    // export one item as BibTeX
    const bib = await ctx.web.exportItems(lib, { format: 'bibtex', limit: 1 });
    expect(typeof bib).toBe('string');

    // sync delta from version 0 returns a key->version map for items
    const versions = await ctx.web.versions(lib, 'items', 0);
    expect(Object.keys(versions).length).toBeGreaterThan(0);
  }, 30_000);

  it('formats a bibliography with citeproc (real CSL style + locale)', async () => {
    const { formatBibliography } = await import('../../src/features/citation/citeproc-engine.js');
    const { StyleResolver } = await import('../../src/features/citation/styles.js');
    const resolver = new StyleResolver();
    const styleXml = await resolver.fetchStyle(resolver.resolveId('APA 7th'));
    const localeXml = await resolver.fetchLocale('en-US');
    const items = [
      {
        id: 'item-1',
        type: 'article-journal',
        title: 'Attention Is All You Need',
        author: [{ family: 'Vaswani', given: 'Ashish' }],
        issued: { 'date-parts': [[2017]] },
        'container-title': 'NeurIPS',
      },
    ];
    const { bibliography } = formatBibliography({ items, styleXml, localeXml, format: 'text' });
    expect(bibliography).toMatch(/Vaswani/);
    expect(bibliography).toMatch(/Attention Is All You Need/);
  }, 30_000);

  it('formats a real library item via zotero_format_bibliography (export csljson -> citeproc)', async () => {
    const { ctx } = await buildServer(loadConfig(process.env));
    const formatBib = (await import('../../src/tools/format-bibliography.js')).default;
    const top = await ctx.router.searchItems({ limit: 1, top: true });
    const key = (top.data[0] as any)?.key;
    expect(key).toBeTruthy();
    const res = await formatBib.handler({ item_keys: [key], style: 'APA 7th', format: 'text' }, ctx);
    expect(res.isError).toBeUndefined();
    expect((res.content[0].text as string).length).toBeGreaterThan(10);
  }, 30_000);

  it('get_fulltext returns passages with locators for a real PDF item', async () => {
    const { ctx } = await buildServer(loadConfig(process.env));
    // Find a top-level item that has a PDF child with extracted full text.
    const list = await ctx.router.searchItems({ top: true, limit: 25 });
    let found: any;
    for (const it of list.data) {
      const key = (it as any)?.key;
      if (!key) continue;
      const res = await getFulltext.handler({ item_key: key, query: 'method' }, ctx);
      if (!res.isError && (res.structuredContent as any)?.passages?.length) {
        found = res;
        break;
      }
    }
    expect(found, 'no item with extracted full text found in the first 25').toBeTruthy();
    const sc = found.structuredContent as any;
    expect(sc.passages[0].charStart).toBeGreaterThanOrEqual(0);
    expect(['exact', 'approximate']).toContain(sc.pageSource);

    // Exercise the real PDF re-extraction (exact-page) path on the same item.
    const itemKey = sc.item_key;
    const precise = await getFulltext.handler({ item_key: itemKey, query: 'method', precise_pages: true }, ctx);
    const psc = precise.structuredContent as any;
    expect(['exact', 'approximate']).toContain(psc.pageSource);
    if (psc.pageSource === 'exact') {
      expect(typeof psc.passages[0].page).toBe('number');
    }
    // precise_pages re-downloads + parses the real PDF (pdfjs), which is slow.
  }, 180_000);
});

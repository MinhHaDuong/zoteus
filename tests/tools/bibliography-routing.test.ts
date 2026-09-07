import { describe, it, expect, vi } from 'vitest';
import { LibraryRouter } from '../../src/router/library-router.js';
import { WebApiClient } from '../../src/api/web-client.js';
import { LocalApiClient } from '../../src/api/local-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';
import { loadConfig } from '../../src/config.js';

// What is under test is which transport the two item-key tools read from, not citeproc-js:
// record what the engine is handed and answer with a fixed rendering.
const { formatBibliography } = vi.hoisted(() => ({
  formatBibliography: vi.fn(() => ({
    bibliography: '<div class="csl-bib-body"><div>Wu, W. (2026).</div></div>',
    entries: ['<div>Wu, W. (2026).</div>'],
  })),
}));
vi.mock('../../src/features/citation/citeproc-engine.js', () => ({ formatBibliography }));

const { default: bibliography } = await import('../../src/tools/bibliography.js');
const { default: formatBib } = await import('../../src/tools/format-bibliography.js');

const BIB =
  '<div class="csl-bib-body"><div class="csl-entry">Wu, W. (2026). ' +
  '<i>A Pragmatic VLA Foundation Model</i>.</div></div>';
// What Zotero 10.0.1 answers for ?format=csljson: a bare array, where the cloud wraps one
// in { items: [...] }.
const CSL = [
  {
    id: 'wuPragmaticVLAFoundation2026',
    type: 'article',
    title: 'A Pragmatic VLA Foundation Model',
  },
];
const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };

/**
 * The real handlers over the real router and the real clients, with both transports'
 * fetchers replaced by stubs that record every URL they are asked for. `key` present means
 * a cloud identity was resolved; absent is the key-free mode of the report.
 */
function harness(
  opts: { key?: string; localGroupIds?: number[]; localAnswer?: (url: string) => Response } = {},
) {
  const webUrls: string[] = [];
  const localUrls: string[] = [];
  const webFetch = vi.fn(async (url: string) => {
    webUrls.push(url);
    // What api.zotero.org says to users/0, deterministically; any other library renders.
    if (url.includes('/users/0/')) return new Response('Invalid user ID', { status: 400 });
    const body = url.includes('format=csljson') ? JSON.stringify({ items: CSL }) : BIB;
    return new Response(body, { status: 200 });
  });
  const localFetch = vi.fn(async (url: string) => {
    localUrls.push(url);
    if (opts.localAnswer) return opts.localAnswer(url);
    const body = url.includes('format=csljson') ? JSON.stringify(CSL) : BIB;
    return new Response(body, { status: 200 });
  });
  const web = new WebApiClient({
    apiKey: opts.key,
    fetcher: new RateLimitedFetcher({ fetchImpl: webFetch, maxConcurrency: 4 }),
  });
  const local = new LocalApiClient({
    fetcher: new RateLimitedFetcher({ fetchImpl: localFetch, maxConcurrency: 4 }),
  });
  const config = loadConfig({ ZOTEUS_LOCAL: 'on', ZOTERO_API_KEY: opts.key } as any);
  const capabilities = {
    cloud: opts.key ? cloudInfo : null,
    localApi: true,
    localGroupIds: opts.localGroupIds ?? [],
  };
  const router = new LibraryRouter({ config, capabilities, web, local });
  const styles = {
    resolveId: (s: string) => (s === 'chicago' ? 'chicago-shortened-notes-bibliography' : s),
    fetchStyle: vi.fn(async () => '<style/>'),
    fetchLocale: vi.fn(async () => '<locale/>'),
  };
  const ctx = { config, capabilities, router, web, local, styles } as any;
  return { ctx, webUrls, localUrls };
}

const pathOf = (url: string) => new URL(url).pathname;
const paramsOf = (url: string) => new URL(url).searchParams;

describe('item-key bibliography reads follow the library route (#64)', () => {
  it('renders a personal-library bibliography from the desktop app with no cloud key', async () => {
    const { ctx, webUrls, localUrls } = harness();
    const res = await bibliography.handler(
      { item_keys: ['NJU4MEZT'], style: 'chicago', locale: 'fr-FR', linkwrap: true },
      ctx,
    );
    expect(res.content[0].text).toBe(BIB);
    // Nothing reached the cloud at all, so nothing reached users/0 there.
    expect(webUrls).toEqual([]);
    expect(localUrls).toHaveLength(1);
    expect(new URL(localUrls[0]).origin + pathOf(localUrls[0])).toBe(
      'http://127.0.0.1:23119/api/users/0/items',
    );
    const q = paramsOf(localUrls[0]);
    expect(q.get('itemKey')).toBe('NJU4MEZT');
    expect(q.get('format')).toBe('bib');
    // The alias table still applies before the request, and locale and linkwrap ride along:
    // the desktop honours all three exactly as the cloud does.
    expect(q.get('style')).toBe('chicago-shortened-notes-bibliography');
    expect(q.get('locale')).toBe('fr-FR');
    expect(q.get('linkwrap')).toBe('1');
    expect((res.structuredContent as any).style).toBe('chicago-shortened-notes-bibliography');
  });

  it('exports CSL-JSON for zotero_format_bibliography item_keys from the desktop app', async () => {
    const { ctx, webUrls, localUrls } = harness();
    const res = await formatBib.handler(
      { item_keys: ['NJU4MEZT', 'CKSETW3U'], style: 'apa', format: 'text' },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(webUrls).toEqual([]);
    expect(localUrls).toHaveLength(1);
    // /items/top, not /items: the desktop's keyed /items answers with the items' children
    // too, and citeproc would render each attachment as an entry of its own.
    expect(pathOf(localUrls[0])).toBe('/api/users/0/items/top');
    const q = paramsOf(localUrls[0]);
    expect(q.get('format')).toBe('csljson');
    expect(q.get('itemKey')).toBe('NJU4MEZT,CKSETW3U');
    // The desktop's csljson is a bare array; it must reach citeproc as the items.
    expect(formatBibliography).toHaveBeenLastCalledWith(
      expect.objectContaining({ items: CSL, format: 'text' }),
    );
    expect((res.structuredContent as any).entryCount).toBe(1);
    // Style and locale still come from the resolver, whichever transport served the items.
    expect(ctx.styles.fetchStyle).toHaveBeenCalledWith('apa');
    expect(ctx.styles.fetchLocale).toHaveBeenCalledWith('en-US');
  });

  it('serves a group the desktop holds from the desktop, for both tools', async () => {
    const { ctx, webUrls, localUrls } = harness({ localGroupIds: [777] });
    const group = { library_type: 'group', library_id: 777 };
    await bibliography.handler({ item_keys: ['K1'], style: 'apa', ...group }, ctx);
    await formatBib.handler({ item_keys: ['K1'], ...group }, ctx);
    expect(webUrls).toEqual([]);
    expect(localUrls.map(pathOf)).toEqual(['/api/groups/777/items', '/api/groups/777/items/top']);
    expect(paramsOf(localUrls[0]).get('format')).toBe('bib');
    expect(paramsOf(localUrls[0]).get('style')).toBe('apa');
    expect(paramsOf(localUrls[1]).get('format')).toBe('csljson');
  });

  it('keeps an explicit cloud library on the cloud, with style and locale intact', async () => {
    // A group this desktop does not hold belongs to api.zotero.org, exactly as before.
    const { ctx, webUrls, localUrls } = harness({ key: 'KEY', localGroupIds: [777] });
    const group = { library_type: 'group', library_id: 999 };
    const res = await bibliography.handler(
      { item_keys: ['K1'], style: 'apa', locale: 'de-DE', ...group },
      ctx,
    );
    await formatBib.handler({ item_keys: ['K1'], ...group }, ctx);
    expect(res.content[0].text).toBe(BIB);
    expect(localUrls).toEqual([]);
    expect(webUrls.map(pathOf)).toEqual(['/groups/999/items', '/groups/999/items']);
    expect(new URL(webUrls[0]).origin).toBe('https://api.zotero.org');
    expect(paramsOf(webUrls[0]).get('format')).toBe('bib');
    expect(paramsOf(webUrls[0]).get('style')).toBe('apa');
    expect(paramsOf(webUrls[0]).get('locale')).toBe('de-DE');
    expect(paramsOf(webUrls[1]).get('format')).toBe('csljson');
    // And the cloud's { items } wrapper still parses.
    expect(formatBibliography).toHaveBeenLastCalledWith(expect.objectContaining({ items: CSL }));
  });

  it('leaves the supplied-CSL path alone: no transport is touched', async () => {
    const { ctx, webUrls, localUrls } = harness();
    const res = await formatBib.handler({ items: CSL, style: 'apa' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(webUrls).toEqual([]);
    expect(localUrls).toEqual([]);
    expect(formatBibliography).toHaveBeenLastCalledWith(expect.objectContaining({ items: CSL }));
  });

  it("surfaces the desktop's own answer for a style it cannot find", async () => {
    // Zotero 10 fetches a style it lacks from the repository and answers 400 with the reason.
    // That text is what the caller needs to see, not a bare status code.
    const reason =
      'Invalid style: not-a-style (HTTP GET https://www.zotero.org/styles/not-a-style ' +
      'failed with status code 404)';
    const { ctx } = harness({ localAnswer: () => new Response(reason, { status: 400 }) });
    await expect(
      bibliography.handler({ item_keys: ['K1'], style: 'not-a-style' }, ctx),
    ).rejects.toThrow(/Invalid style: not-a-style/);
  });
});

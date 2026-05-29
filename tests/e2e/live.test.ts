import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';

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
});

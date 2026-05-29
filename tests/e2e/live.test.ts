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
});

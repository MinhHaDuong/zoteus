import { describe, it, expect } from 'vitest';
import whoami from '../../src/tools/whoami.js';

/** Minimal SearchIndex stand-in: healthy local embedder unless overridden. */
function searchStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    embedderConfigured: 'local',
    embedderActive: true,
    embedderName: 'local',
    embedderReason: undefined,
    ...over,
  };
}

function ctxWith(cloud: any, search: any = searchStub()) {
  return {
    router: {
      whoami: () => cloud,
      defaultLibrary: () => ({ type: 'user', id: cloud?.userID ?? 0 }),
    },
    capabilities: { cloud, localApi: true },
    search,
  } as any;
}

describe('zotero_whoami', () => {
  it('returns the resolved identity and access', async () => {
    const res = await whoami.handler(
      {},
      ctxWith({ userID: 19552201, username: 'oscardvs', access: { user: { write: true } } }),
    );
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.userID).toBe(19552201);
    expect(res.content[0].text).toMatch(/oscardvs/);
  });

  it('reports local-only mode when no cloud key is configured', async () => {
    const res = await whoami.handler({}, ctxWith(null));
    expect(res.structuredContent?.cloud).toBe(false);
    expect(res.content[0].text).toMatch(/local/i);
  });

  it('surfaces an available update, with the reinstall hint on desktop-extension installs', async () => {
    const ctx = ctxWith(null);
    ctx.config = { dist: 'mcpb' };
    ctx.updates = {
      available: { current: '1.3.1', latest: '1.4.0', url: 'https://github.com/oscardvs/zoteus/releases/tag/v1.4.0' },
    };
    const res = await whoami.handler({}, ctx);
    expect(res.structuredContent?.update).toEqual(ctx.updates.available);
    expect(res.content[0].text).toMatch(/1\.4\.0 is available/);
    expect(res.content[0].text).toMatch(/reinstall/i);
  });

  it('reports a degraded embedder so a keyword-only fallback is visible on the first call', async () => {
    const res = await whoami.handler(
      {},
      ctxWith(null, {
        embedderConfigured: 'local',
        embedderActive: false,
        embedderName: 'none (local requested; @huggingface/transformers is not installed)',
        embedderReason: '@huggingface/transformers is not installed, so semantic ranking is off',
      }),
    );
    expect((res.structuredContent?.embeddings as any).active).toBe(false);
    expect((res.structuredContent?.embeddings as any).configured).toBe('local');
    expect(res.content[0].text).toMatch(/degraded to keyword-only/i);
    expect(res.content[0].text).toMatch(/@huggingface\/transformers/);
  });

  it('stays quiet about embeddings when the configured provider is running', async () => {
    const res = await whoami.handler({}, ctxWith(null));
    expect((res.structuredContent?.embeddings as any).active).toBe(true);
    expect(res.content[0].text).not.toMatch(/degraded/i);
  });

  it('omits the update notice when no newer release is known', async () => {
    const res = await whoami.handler({}, ctxWith(null));
    expect(res.structuredContent?.update).toBeNull();
    expect(res.content[0].text).not.toMatch(/available \(installed/);
  });
});

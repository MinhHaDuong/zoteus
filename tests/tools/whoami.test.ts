import { describe, it, expect } from 'vitest';
import whoami from '../../src/tools/whoami.js';

function ctxWith(cloud: any) {
  return {
    router: {
      whoami: () => cloud,
      defaultLibrary: () => ({ type: 'user', id: cloud?.userID ?? 0 }),
    },
    capabilities: { cloud, localApi: true },
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
});

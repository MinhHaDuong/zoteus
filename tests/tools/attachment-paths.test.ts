import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import attachment from '../../src/tools/attachment.js';
import attachFile from '../../src/tools/attach-file.js';

/**
 * The guard itself is unit-tested in tests/lib/caller-path.test.ts. These check that the
 * tools are actually WIRED to it, which is the part a refactor would silently drop, and
 * that a stdio caller keeps the behaviour the tools exist for.
 */
function ctx(over: Record<string, unknown> = {}) {
  return {
    config: { dataDir: join(tmpdir(), 'zoteus-data-does-not-exist') },
    remoteCaller: true,
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    ...over,
  } as never;
}

const text = (res: { content?: { text: string }[] }) =>
  (res.content ?? []).map((c) => c.text).join('\n');

describe('caller-supplied paths on a shared deployment', () => {
  it('zotero_attachment refuses a save_path outside the data directory', async () => {
    const res = await attachment.handler(
      { action: 'download', item_key: 'ABCD1234', save_path: '/app/dist/index.js' },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('save_path');
  });

  it('zotero_attachment refuses a file_path outside the data directory', async () => {
    const res = await attachment.handler(
      { action: 'upload', file_path: '/proc/self/environ' },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('file_path');
  });

  it('zotero_attach_file refuses a path outside the data directory', async () => {
    const res = await attachFile.handler({ parent: 'ABCD1234', path: '/etc/passwd' }, ctx());
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('`path`');
  });

  it('points the caller at `url`, which works on every setup', async () => {
    const res = await attachFile.handler({ parent: 'ABCD1234', path: '/etc/passwd' }, ctx());
    expect(text(res)).toContain('url');
  });

  it('refuses to replace an existing file even inside the data directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'zoteus-attach-'));
    const target = join(dataDir, 'already-here.pdf');
    await writeFile(target, 'original');
    try {
      const res = await attachment.handler(
        { action: 'download', item_key: 'ABCD1234', save_path: target },
        ctx({ config: { dataDir } }),
      );
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('overwrite');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('a stdio caller is not confined: the tool exists to write where you ask', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'zoteus-attach-'));
    try {
      // remoteCaller false, so the guard passes the path through and the handler proceeds
      // to the download itself, which fails on the stub web client rather than on the path.
      const res = await attachment.handler(
        { action: 'download', item_key: 'ABCD1234', save_path: '/tmp/zoteus-anywhere.pdf' },
        ctx({
          config: { dataDir },
          remoteCaller: false,
          capabilities: { cloud: { userID: 1 } },
          web: {
            downloadFileBytes: async () => {
              throw new Error('stub: reached the download, not blocked by the path guard');
            },
          },
        }),
      ).catch((e: Error) => ({ content: [{ text: e.message }], isError: true }));
      expect(text(res)).not.toContain('data directory');
      expect(text(res)).toContain('stub: reached the download');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

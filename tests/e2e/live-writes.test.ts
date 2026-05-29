import { describe, it, expect } from 'vitest';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import createItems from '../../src/tools/create-items.js';
import updateItem from '../../src/tools/update-item.js';
import trashItems from '../../src/tools/trash-items.js';
import { uploadFile, downloadFile } from '../../src/api/attachments.js';

// Double-gated: only runs with BOTH a real key AND an explicit opt-in, so normal
// `npm test` and CI never mutate the real library. Self-cleaning (permanently
// deletes the item it creates).
const enabled = Boolean(process.env.ZOTERO_API_KEY) && process.env.ZOTEUS_E2E_WRITE === 'true';
const d = enabled ? describe : describe.skip;

d('Zoteus e2e writes (live, self-cleaning)', () => {
  it('creates, updates, trashes, and permanently deletes a test item', async () => {
    const config = loadConfig(process.env);
    const { ctx } = await buildServer(config);
    const lib = ctx.router.defaultLibrary();
    const title = `ZOTEUS_E2E ${new Date().toISOString()}`;
    let key: string | undefined;

    try {
      // 1. create
      const created = await createItems.handler(
        { items: [{ itemType: 'journalArticle', title }] },
        ctx,
      );
      expect(created.isError).toBeUndefined();
      const createdItems = created.structuredContent?.created as Array<{ key: string; version?: number }>;
      expect(createdItems.length).toBe(1);
      key = createdItems[0].key;
      expect(key).toBeTruthy();

      // 2. update
      const updated = await updateItem.handler(
        { item_key: key, patch: { extra: 'updated by zoteus e2e' } },
        ctx,
      );
      expect(updated.isError).toBeUndefined();
      expect(updated.structuredContent?.newVersion).toBeTypeOf('number');

      // 3. trash (reversible)
      const trashed = await trashItems.handler({ item_keys: [key] }, ctx);
      expect(trashed.isError).toBeUndefined();
      expect((trashed.structuredContent?.updated as string[])).toContain(key);
    } finally {
      // 4. cleanup: permanent delete so the test leaves nothing behind
      if (key) {
        const v = await ctx.web.currentLibraryVersion(lib);
        await ctx.web.deleteItems(lib, [key], v);
      }
    }
  }, 60_000);

  it('uploads and downloads an attachment file via the full protocol (self-cleaning)', async () => {
    const config = loadConfig(process.env);
    const { ctx } = await buildServer(config);
    const lib = ctx.router.defaultLibrary();
    const src = join(tmpdir(), `zoteus-e2e-${process.pid}.txt`);
    const content = `ZOTEUS_E2E attachment ${new Date().toISOString()}`;
    await writeFile(src, content);
    let key: string | undefined;
    try {
      const up = await uploadFile(ctx.web, lib, { filePath: src, title: 'ZOTEUS_E2E attachment' });
      key = up.key;
      expect(key).toBeTruthy();
      expect(up.exists).toBe(false);

      const dst = join(tmpdir(), `zoteus-e2e-dl-${process.pid}.txt`);
      const dl = await downloadFile(ctx.web, lib, key, dst);
      expect(dl.bytes).toBe(Buffer.byteLength(content));
      expect(await readFile(dst, 'utf8')).toBe(content);
      await rm(dst).catch(() => undefined);
    } finally {
      if (key) {
        const v = await ctx.web.currentLibraryVersion(lib);
        await ctx.web.deleteItems(lib, [key], v);
      }
      await rm(src).catch(() => undefined);
    }
  }, 90_000);
});

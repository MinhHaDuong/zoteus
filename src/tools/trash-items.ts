import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, requireCloudLibrary, isLocalWritesUnavailable, ensureLocalApi } from '../registry/registry.js';

function versionOf(item: any): number | undefined {
  return item?.version ?? item?.data?.version;
}

const trashItems: ToolDefinition = {
  name: 'zotero_trash_items',
  title: 'Trash or restore Zotero items',
  description:
    'Move items to the trash (the safe, REVERSIBLE default) or restore them. This sets the `deleted` flag (1=trash, 0=restore) — it is NOT a permanent delete, so trashed items can be recovered here or in the Zotero app. Use this instead of zotero_delete_items unless you truly need irreversible removal. Provide `item_keys` and optional `action` (default "trash"). Writes go to the running Zotero desktop app for your personal library (via its local-API writes where available), otherwise to the cloud Web API.',
  inputSchema: {
    item_keys: z.array(z.string()).min(1).describe('Item keys to trash or restore.'),
    action: z.enum(['trash', 'restore']).optional().describe('Default "trash".'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const deleted = args.action === 'restore' ? 0 : 1;
    // Local-first for the personal library when the desktop app supports writes.
    if (ctx.localWrites && !args.library_id && (await ensureLocalApi(ctx))) {
      try {
        if (deleted === 1) {
          await ctx.localWrites.deleteItems(args.item_keys, false);
          return ok({ updated: args.item_keys, target: 'local' }, `Trashed ${args.item_keys.length} item(s) via the Zotero desktop app.`);
        }
        const objects: any[] = [];
        for (const key of args.item_keys) objects.push({ key, deleted: 0 });
        const result = await ctx.localWrites.writeItems(objects);
        return ok(
          { updated: result.successful.map((s) => s.key), failed: result.failed, target: 'local' },
          `Restored ${result.successful.length} item(s) via the Zotero desktop app.`,
        );
      } catch (e) {
        if (!isLocalWritesUnavailable(e)) throw e;
        ctx.logger.info(`Local-API writes unavailable (${e instanceof Error ? e.message : e}); falling back to the cloud Web API.`);
      }
    }
    const lib = requireCloudLibrary(ctx, args);
    const objects: any[] = [];
    for (const key of args.item_keys) {
      const version = versionOf(await ctx.web.getItem(lib, key));
      objects.push({ key, version, deleted });
    }
    const result = await ctx.web.writeItems(lib, objects);
    const verb = deleted ? 'Trashed' : 'Restored';
    const summary =
      `${verb} ${result.successful.length} item(s)` +
      (result.failed.length ? `; ${result.failed.length} failed.` : '.');
    return ok(
      { updated: result.successful.map((s) => s.key), failed: result.failed, libraryVersion: result.newLibraryVersion },
      summary,
    );
  },
};

export default trashItems;

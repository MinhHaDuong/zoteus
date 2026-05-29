import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';

function versionOf(item: any): number | undefined {
  return item?.version ?? item?.data?.version;
}

const trashItems: ToolDefinition = {
  name: 'zotero_trash_items',
  title: 'Trash or restore Zotero items',
  description:
    'Move items to the trash (the safe, REVERSIBLE default) or restore them. This sets the `deleted` flag (1=trash, 0=restore) — it is NOT a permanent delete, so trashed items can be recovered here or in the Zotero app. Use this instead of zotero_delete_items unless you truly need irreversible removal. Provide `item_keys` and optional `action` (default "trash"). Writes go to the cloud Web API.',
  inputSchema: {
    item_keys: z.array(z.string()).min(1).describe('Item keys to trash or restore.'),
    action: z.enum(['trash', 'restore']).optional().describe('Default "trash".'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = requireCloudLibrary(ctx, args);
    const deleted = args.action === 'restore' ? 0 : 1;
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

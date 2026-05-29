import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';

const deleteItems: ToolDefinition = {
  name: 'zotero_delete_items',
  title: 'Permanently delete Zotero items',
  description:
    'PERMANENTLY and IRREVERSIBLY delete items by key (this purges them — it is NOT the trash). Prefer zotero_trash_items, which is reversible. This tool is disabled unless the server is started with ZOTEUS_ALLOW_DELETE=true, and additionally requires `confirm: true` on every call. The current library version is used as a precondition; the operation auto-chunks to 50 keys per request.',
  inputSchema: {
    item_keys: z.array(z.string()).min(1).describe('Item keys to permanently delete.'),
    confirm: z.boolean().optional().describe('Must be true to proceed with permanent deletion.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (!ctx.config.allowDelete) {
      return {
        content: [
          {
            type: 'text',
            text: 'Permanent delete is disabled. Start Zoteus with ZOTEUS_ALLOW_DELETE=true to enable it, or use zotero_trash_items (reversible).',
          },
        ],
        isError: true,
      };
    }
    if (!args.confirm) {
      return {
        content: [
          {
            type: 'text',
            text: `Refusing to permanently delete ${args.item_keys.length} item(s) without confirmation. Re-call with confirm:true if you are sure (this cannot be undone).`,
          },
        ],
        isError: true,
      };
    }
    const lib = requireCloudLibrary(ctx, args);
    const version = await ctx.web.currentLibraryVersion(lib);
    await ctx.web.deleteItems(lib, args.item_keys, version);
    return ok(
      { deleted: args.item_keys, count: args.item_keys.length },
      `Permanently deleted ${args.item_keys.length} item(s).`,
    );
  },
};

export default deleteItems;

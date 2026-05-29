import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';
import { ZoteroApiError } from '../api/errors.js';

function versionOf(item: any): number | undefined {
  return item?.version ?? item?.data?.version;
}

const updateItem: ToolDefinition = {
  name: 'zotero_update_item',
  title: 'Update a Zotero item',
  description:
    'Partially update one item (HTTP PATCH — only the fields you supply change; omitted fields are preserved). Provide `item_key` and a `patch` object of the fields to change (e.g. {"title":"New","extra":"note"} or {"tags":[{"tag":"reviewed"}]}). Optimistic concurrency is handled for you: if you pass the item\'s `version` it is used; otherwise the current version is fetched first. If the item changed on the server in the meantime (412), the update is automatically re-fetched and retried once. Writes go to the cloud Web API.',
  inputSchema: {
    item_key: z.string().describe('The 8-character item key.'),
    patch: z.record(z.any()).describe('Object of fields to change (PATCH semantics).'),
    version: z.number().int().optional().describe('Known current version; fetched automatically if omitted.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = requireCloudLibrary(ctx, args);
    let version = args.version;
    if (version == null) {
      version = versionOf(await ctx.web.getItem(lib, args.item_key));
    }
    if (version == null) {
      return {
        content: [{ type: 'text', text: `Could not determine the current version of ${args.item_key}.` }],
        isError: true,
      };
    }
    try {
      const newVersion = await ctx.web.patchItem(lib, args.item_key, args.patch, version);
      return ok({ item_key: args.item_key, newVersion }, `Updated ${args.item_key} (now version ${newVersion}).`);
    } catch (err) {
      if (err instanceof ZoteroApiError && err.status === 412) {
        const fresh = versionOf(await ctx.web.getItem(lib, args.item_key));
        if (fresh == null) throw err;
        const newVersion = await ctx.web.patchItem(lib, args.item_key, args.patch, fresh);
        return ok(
          { item_key: args.item_key, newVersion, retried: true },
          `Updated ${args.item_key} after a version conflict (now version ${newVersion}).`,
        );
      }
      throw err;
    }
  },
};

export default updateItem;

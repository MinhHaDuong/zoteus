import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';
import { itemsArraySchema } from '../schema/item-payload.js';

const createItems: ToolDefinition = {
  name: 'zotero_create_items',
  title: 'Create or update Zotero items',
  description:
    'Create new items or update existing ones in a single batch (the server auto-chunks into groups of 50). Each entry in `items` is a Zotero item-data object: include `itemType` plus its valid fields, `creators` (each `{creatorType, firstName, lastName}` or `{creatorType, name}`), `tags` (`[{tag}]`), and `collections` (array of collection keys). To UPDATE an existing item, also include its `key` and current `version`; to CREATE, omit both. Every item is validated against the Zotero schema before anything is sent — if any item is invalid, nothing is written and the problems are returned. Use zotero_schema to discover valid fields/creator types for an itemType. Writes go to the cloud Web API (requires ZOTERO_API_KEY).',
  inputSchema: {
    items: itemsArraySchema.describe(
      'Array of Zotero item-data objects (itemType + fields; include key+version to update).',
    ),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = requireCloudLibrary(ctx, args);
    const problems: string[] = [];
    for (let i = 0; i < args.items.length; i++) {
      const v = await ctx.schema.validateItem(args.items[i]);
      if (!v.valid) problems.push(`items[${i}]: ${v.errors.join('; ')}`);
    }
    if (problems.length) {
      return {
        content: [{ type: 'text', text: `Validation failed; nothing was written:\n- ${problems.join('\n- ')}` }],
        isError: true,
      };
    }
    const result = await ctx.web.writeItems(lib, args.items);
    const created = result.successful.map((s) => ({ key: s.key, version: s.version }));
    const summary =
      `Wrote ${result.successful.length} item(s)` +
      (result.failed.length ? `; ${result.failed.length} failed.` : '.');
    return ok(
      { created, failed: result.failed, libraryVersion: result.newLibraryVersion },
      summary,
    );
  },
};

export default createItems;

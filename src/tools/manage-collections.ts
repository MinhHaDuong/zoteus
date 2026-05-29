import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

async function fetchCollection(ctx: ToolContext, lib: LibraryRef, key: string): Promise<any | undefined> {
  const r = await ctx.web.listCollections(lib, { limit: 100 });
  return r.data.find((c: any) => (c.key ?? c.data?.key) === key);
}

const manageCollections: ToolDefinition = {
  name: 'zotero_manage_collections',
  title: 'Manage Zotero collections',
  description:
    'List, create, rename, reparent, or delete collections, and move items into or out of a collection. Set `action` to one of: "list" (all collections with key/name/parent), "create" (needs `name`, optional `parent_collection` key — omit for top-level), "rename" (needs `collection_key` + `name`), "reparent" (needs `collection_key`; `parent_collection` key, or omit to move to top level), "delete" (needs `collection_key`), "add_items" / "remove_items" (need `collection_key` + `item_keys`; collection membership lives on each item). All actions except "list" write to the cloud Web API.',
  inputSchema: {
    action: z.enum(['list', 'create', 'rename', 'reparent', 'delete', 'add_items', 'remove_items']),
    name: z.string().optional().describe('Collection name (create/rename).'),
    collection_key: z.string().optional().describe('Target collection key (all actions except list/create).'),
    parent_collection: z.string().optional().describe('Parent collection key; omit for top-level.'),
    item_keys: z.array(z.string()).optional().describe('Item keys (add_items/remove_items).'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'list') {
      const r = await ctx.router.listCollections({});
      const collections = r.data.map((c: any) => ({
        key: c.key ?? c.data?.key,
        name: c.data?.name,
        parentCollection: c.data?.parentCollection ?? false,
        numItems: c.meta?.numItems,
      }));
      return ok({ collections }, `${collections.length} collection(s).`);
    }

    const lib = requireCloudLibrary(ctx, args);

    if (args.action === 'create') {
      if (!args.name) return err('`name` is required for create.');
      const result = await ctx.web.writeCollections(lib, [
        { name: args.name, parentCollection: args.parent_collection ?? false },
      ]);
      if (result.failed.length) return err(`Create failed: ${JSON.stringify(result.failed)}`);
      return ok(
        { created: result.successful.map((s) => s.key), libraryVersion: result.newLibraryVersion },
        `Created collection "${args.name}".`,
      );
    }

    if (args.action === 'rename' || args.action === 'reparent') {
      if (!args.collection_key) return err('`collection_key` is required.');
      const existing = await fetchCollection(ctx, lib, args.collection_key);
      if (!existing) return err(`Collection ${args.collection_key} not found.`);
      const obj: any = {
        ...existing.data,
        key: args.collection_key,
        version: existing.version ?? existing.data?.version,
      };
      if (args.action === 'rename') {
        if (!args.name) return err('`name` is required for rename.');
        obj.name = args.name;
      } else {
        obj.parentCollection = args.parent_collection ?? false;
      }
      const result = await ctx.web.writeCollections(lib, [obj]);
      if (result.failed.length) return err(`Update failed: ${JSON.stringify(result.failed)}`);
      return ok(
        { collection_key: args.collection_key, libraryVersion: result.newLibraryVersion },
        `${args.action === 'rename' ? 'Renamed' : 'Reparented'} collection ${args.collection_key}.`,
      );
    }

    if (args.action === 'delete') {
      if (!args.collection_key) return err('`collection_key` is required.');
      const version = await ctx.web.currentLibraryVersion(lib);
      await ctx.web.deleteCollections(lib, [args.collection_key], version);
      return ok({ deleted: args.collection_key }, `Deleted collection ${args.collection_key}.`);
    }

    // add_items / remove_items
    if (!args.collection_key || !args.item_keys?.length) {
      return err('`collection_key` and `item_keys` are required.');
    }
    const updated: string[] = [];
    const failed: Array<{ key: string; message: string }> = [];
    for (const key of args.item_keys) {
      const item = await ctx.web.getItem(lib, key);
      const version = item?.version ?? item?.data?.version;
      const cols: string[] = Array.isArray(item?.data?.collections) ? [...item.data.collections] : [];
      const next =
        args.action === 'add_items'
          ? cols.includes(args.collection_key)
            ? cols
            : [...cols, args.collection_key]
          : cols.filter((c) => c !== args.collection_key);
      try {
        await ctx.web.patchItem(lib, key, { collections: next }, version);
        updated.push(key);
      } catch (e) {
        failed.push({ key, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return ok(
      { updated, failed },
      `${args.action === 'add_items' ? 'Added' : 'Removed'} ${updated.length} item(s) ${
        args.action === 'add_items' ? 'to' : 'from'
      } ${args.collection_key}.`,
    );
  },
};

export default manageCollections;

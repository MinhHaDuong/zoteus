import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const SYNC_TYPES = ['items', 'collections', 'searches', 'tags'] as const;

const sync: ToolDefinition = {
  name: 'zotero_sync',
  title: 'Incremental sync delta',
  description:
    'Return what changed in a library since a given version, for efficient incremental sync. Provide `since` (a library version; 0 = everything). Returns, per object type (items/collections/searches/tags), the map of keys→version that changed after `since`, plus the deletion log (keys removed since `since`). This is the version-based delta the Zotero sync algorithm uses — fetch the changed keys, then pull only those with zotero_get_item/zotero_search_items. Reads via the cloud Web API.',
  inputSchema: {
    since: z.number().int().min(0).optional().describe('Library version to diff from (default 0).'),
    types: z.array(z.enum(SYNC_TYPES)).optional().describe('Which object types to check (default all).'),
    include_deleted: z.boolean().optional().describe('Include the deletion log (default true).'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : ctx.router.defaultLibrary();
    const since = args.since ?? 0;
    const types = (args.types ?? SYNC_TYPES) as readonly (typeof SYNC_TYPES)[number][];

    const changed: Record<string, { count: number; keys: string[] }> = {};
    for (const type of types) {
      const map = await ctx.web.versions(lib, type, since);
      const keys = Object.keys(map);
      changed[type] = { count: keys.length, keys };
    }

    const structured: Record<string, unknown> = { since, changed };
    if (args.include_deleted !== false) {
      structured.deleted = await ctx.web.deleted(lib, since);
    }

    const summary = Object.entries(changed)
      .map(([t, v]) => `${v.count} ${t}`)
      .join(', ');
    return ok(structured, `Changes since v${since}: ${summary}.`);
  },
};

export default sync;

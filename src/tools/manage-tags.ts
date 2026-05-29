import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const manageTags: ToolDefinition = {
  name: 'zotero_manage_tags',
  title: 'Manage Zotero tags',
  description:
    'List tags, or add/remove tags on items. Set `action` to "list" (returns library tags; supports `q` substring filter), "add" (add `tags` to each of `item_keys`), or "remove" (remove `tags` from each of `item_keys`). Tags are stored on the parent item\'s tag array, so add/remove edits the items (cloud Web API). Tag names are case-sensitive.',
  inputSchema: {
    action: z.enum(['list', 'add', 'remove']),
    tags: z.array(z.string()).optional().describe('Tag names to add or remove.'),
    item_keys: z.array(z.string()).optional().describe('Items to modify (add/remove).'),
    q: z.string().optional().describe('Substring filter for list.'),
    limit: z.number().int().min(1).max(100).optional(),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'list') {
      const lib = ctx.router.defaultLibrary();
      const r = await ctx.web.listTags(lib, { q: args.q, limit: args.limit ?? 100 });
      const tags = r.data.map((t: any) => (typeof t === 'string' ? t : t.tag));
      return ok({ tags, totalResults: r.totalResults }, `${tags.length} tag(s) returned.`);
    }

    if (!args.tags?.length || !args.item_keys?.length) {
      return err('`tags` and `item_keys` are required for add/remove.');
    }
    const lib = requireCloudLibrary(ctx, args);
    const updated: string[] = [];
    const failed: Array<{ key: string; message: string }> = [];
    for (const key of args.item_keys) {
      const item = await ctx.web.getItem(lib, key);
      const version = item?.version ?? item?.data?.version;
      const current: Array<{ tag: string; type?: number }> = Array.isArray(item?.data?.tags)
        ? [...item.data.tags]
        : [];
      let next: Array<{ tag: string; type?: number }>;
      if (args.action === 'add') {
        const have = new Set(current.map((t) => t.tag));
        next = [...current, ...args.tags.filter((t: string) => !have.has(t)).map((t: string) => ({ tag: t }))];
      } else {
        const remove = new Set(args.tags);
        next = current.filter((t) => !remove.has(t.tag));
      }
      try {
        await ctx.web.patchItem(lib, key, { tags: next }, version);
        updated.push(key);
      } catch (e) {
        failed.push({ key, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return ok(
      { updated, failed },
      `${args.action === 'add' ? 'Added' : 'Removed'} tags on ${updated.length} item(s).`,
    );
  },
};

export default manageTags;

import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const listTags: ToolDefinition = {
  name: 'zotero_list_tags',
  title: 'List Zotero tags (read-only)',
  description:
    'List tags in a Zotero library with their usage count and whether each was auto-applied by Zotero. Optional `q` substring filter and `limit`. Read-only — available even when the connector runs in read-only mode (unlike zotero_manage_tags, which also writes). For taxonomy hygiene use zotero_tag_audit.',
  inputSchema: {
    q: z.string().optional().describe('Substring filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Max tags (default 100).'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : ctx.router.defaultLibrary();
    const r = await ctx.web.listTags(lib, { q: args.q, limit: args.limit ?? 100 });
    const tags = r.data.map((t: any) =>
      typeof t === 'string'
        ? { name: t, numItems: undefined, auto: false }
        : { name: t.tag, numItems: t.meta?.numItems, auto: t.meta?.type === 0 },
    );
    return ok({ tags, totalResults: r.totalResults }, `${tags.length} tag(s) returned.`);
  },
};

export default listTags;

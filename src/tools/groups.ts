import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const groups: ToolDefinition = {
  name: 'zotero_groups',
  title: 'List Zotero groups',
  description:
    'List the group libraries the current API key can access, with each group\'s id, name, type, item count, and edit permissions. Use a returned group id with the `library_id`/`library_type:"group"` parameters of other tools to operate on that group library. Requires a cloud API key.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_args, ctx): Promise<ToolHandlerResult> => {
    const me = ctx.router.whoami();
    if (!me) {
      return { content: [{ type: 'text', text: 'Listing groups requires a cloud API key (ZOTERO_API_KEY).' }], isError: true };
    }
    const r = await ctx.web.listGroups(me.userID);
    const groupList = r.data.map((g: any) => ({
      id: g.id ?? g.data?.id,
      name: g.data?.name,
      type: g.data?.type,
      numItems: g.meta?.numItems,
      description: g.data?.description,
      libraryEditing: g.data?.libraryEditing,
    }));
    return ok({ groups: groupList }, `${groupList.length} accessible group(s).`);
  },
};

export default groups;

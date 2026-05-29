import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';

const bibliography: ToolDefinition = {
  name: 'zotero_bibliography',
  title: 'Server-rendered bibliography (library items)',
  description:
    'Produce a formatted bibliography for items already in a Zotero library, rendered server-side by Zotero in a CSL style. Provide `item_keys` and optionally `style` (name or CSL id; Zotero default is chicago-note-bibliography), `locale`, and `linkwrap`. Returns XHTML. Note: this endpoint is item-only and capped at 150 items. For arbitrary CSL-JSON or items not in the library, use zotero_format_bibliography instead.',
  inputSchema: {
    item_keys: z.array(z.string()).min(1).max(150).describe('Library item keys (max 150).'),
    style: z.string().optional().describe('Style name or CSL id.'),
    locale: z.string().optional().describe('Locale (e.g. en-US).'),
    linkwrap: z.boolean().optional().describe('Wrap URLs/DOIs in links.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : ctx.router.defaultLibrary();
    const style = args.style ? ctx.styles.resolveId(args.style) : undefined;
    const text = await ctx.web.getBibliography(lib, args.item_keys, {
      style,
      locale: args.locale,
      linkwrap: args.linkwrap,
    });
    return {
      content: [{ type: 'text', text }],
      structuredContent: { style: style ?? 'chicago-note-bibliography', itemCount: args.item_keys.length },
    };
  },
};

export default bibliography;

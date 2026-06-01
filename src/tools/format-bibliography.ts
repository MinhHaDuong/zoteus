import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { formatBibliography } from '../features/citation/citeproc-engine.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const formatBib: ToolDefinition = {
  name: 'zotero_format_bibliography',
  title: 'Format a bibliography (citeproc / any CSL style)',
  description:
    'Render a formatted bibliography in any CSL style using citeproc-js — no Zotero library write required. Provide either `items` (an array of CSL-JSON objects, e.g. from zotero_import or external metadata) or `item_keys` (library items, which are exported to CSL-JSON first). Choose `style` (a name like "APA 7th" or a CSL id; default "apa"), `locale` (default "en-US"), and `format` (html/text/rtf; default html). The formatted bibliography text is returned. Use this for arbitrary items or styles; for items already in the library you can also use zotero_bibliography (server-rendered).',
  inputSchema: {
    items: z.array(z.record(z.any())).optional().describe('CSL-JSON items to format.'),
    item_keys: z.array(z.string()).optional().describe('Library item keys (exported to CSL-JSON).'),
    style: z.string().optional().describe('Style name or CSL id (default "apa").'),
    locale: z.string().optional().describe('Locale (default "en-US").'),
    format: z.enum(['html', 'text', 'rtf']).optional().describe('Output format (default html).'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    let cslItems: any[] | undefined = args.items;
    if (!cslItems?.length) {
      if (!args.item_keys?.length) return err('Provide `items` (CSL-JSON) or `item_keys`.');
      const lib = args.library_id
        ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
        : ctx.router.defaultLibrary();
      const text = await ctx.web.exportItems(lib, { format: 'csljson', itemKey: args.item_keys, limit: 100 });
      const parsed = JSON.parse(text);
      // Zotero's csljson export wraps items in { items: [...] }; older shapes are a bare array.
      cslItems = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    }
    const styleId = ctx.styles.resolveId(args.style ?? 'apa');
    const [styleXml, localeXml] = await Promise.all([
      ctx.styles.fetchStyle(styleId),
      ctx.styles.fetchLocale(args.locale ?? 'en-US'),
    ]);
    const { bibliography, entries } = formatBibliography({
      items: cslItems!,
      styleXml,
      localeXml,
      format: args.format ?? 'html',
    });
    return {
      content: [{ type: 'text', text: bibliography || '(empty bibliography)' }],
      // `entries` already carries the payload; include the joined `bibliography`
      // string too so struct-only clients get the ready-to-use rendered text.
      structuredContent: { styleId, entryCount: entries.length, entries, bibliography },
    };
  },
};

export default formatBib;

import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';

const EXPORT_FORMATS = [
  'bibtex',
  'biblatex',
  'ris',
  'csljson',
  'csv',
  'mods',
  'tei',
  'coins',
  'rdf_bibliontology',
  'rdf_dc',
  'rdf_zotero',
  'refer',
  'wikipedia',
  'bookmarks',
] as const;

const exportTool: ToolDefinition = {
  name: 'zotero_export',
  title: 'Export Zotero items',
  description:
    'Export items in a bibliographic format and return the raw text. Choose `format` (bibtex, biblatex, ris, csljson, csv, mods, tei, coins, rdf_*, refer, wikipedia, bookmarks). Narrow the set with `item_keys`, `collection_key`, `q`, or `item_type`. A `limit` is always applied (default 50) because export formats require it. For a styled human bibliography (CSL styles like APA/IEEE) use the dedicated bibliography tools instead; this is for machine-readable reference formats. Reads via the cloud Web API.',
  inputSchema: {
    format: z.enum(EXPORT_FORMATS),
    item_keys: z.array(z.string()).optional(),
    collection_key: z.string().optional(),
    q: z.string().optional(),
    item_type: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : ctx.router.defaultLibrary();
    const text = await ctx.web.exportItems(lib, {
      format: args.format,
      itemKey: args.item_keys,
      collectionKey: args.collection_key,
      q: args.q,
      itemType: args.item_type,
      limit: args.limit ?? 50,
    });
    return {
      content: [{ type: 'text', text }],
      structuredContent: { format: args.format, length: text.length },
    };
  },
};

export default exportTool;

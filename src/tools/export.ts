import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { optionalLibrary } from '../registry/registry.js';
import { BbtClient } from '../api/bbt-client.js';

const EXPORT_FORMATS = [
  'bibtex',
  'biblatex',
  'better-biblatex',
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
    'Export items in a bibliographic format and return the raw text. Choose `format` (bibtex, biblatex, better-biblatex, ris, csljson, csv, mods, tei, coins, rdf_*, refer, wikipedia, bookmarks). Stock formats are rendered by Zotero itself: by the desktop app when it serves the selected library (no cloud key needed), by the Web API otherwise. `biblatex` is Zotero\'s STOCK translator; BBT-specific options (citation-key generation, sentence-case, biblatexExtendedNameFormat, unicode→LaTeX) are NOT available there. `better-biblatex` uses the local desktop Better BibTeX plugin (your configured BBT export options apply) and is only available when desktop Zotero + BBT are running; it degrades to built-in `biblatex` otherwise. Narrow with `item_keys`, `collection_key`, `q`, or `item_type`. A `limit` (default 50) is always applied. For styled human bibliographies use the bibliography tools.',
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
    const lib = optionalLibrary(args) ?? ctx.router.defaultLibrary();
    // Routed like every other library read (#64, #75): a library the desktop app serves
    // exports with no cloud key, and the Web API answers for everything else. Before this,
    // both stock calls below went to api.zotero.org unconditionally, which in key-free local
    // mode is users/0 and a refusal.
    const stockExport = (format: string) =>
      ctx.router.exportItems({
        library: lib,
        format,
        itemKey: args.item_keys,
        collectionKey: args.collection_key,
        q: args.q,
        itemType: args.item_type,
        limit: args.limit ?? 50,
      });

    if (args.format === 'better-biblatex') {
      const bbt = ctx.local ? new BbtClient({ port: ctx.config.localPort }) : undefined;
      if (bbt && (await bbt.ping())) {
        try {
          if (!args.item_keys?.length) {
            // BBT export needs item selection; fall back to built-in for whole-library/q exports.
            throw new Error('better-biblatex requires explicit item_keys');
          }
          const citekeys = await bbt.citationKeys(args.item_keys);
          if (citekeys.length) {
            const text = await bbt.exportItems({ citekeys, translator: 'better-biblatex' });
            return {
              content: [{ type: 'text', text }],
              structuredContent: { format: 'better-biblatex', length: text.length, source: 'local-bbt', text },
            };
          }
        } catch (e) {
          ctx.logger?.warn?.(`Better BibTeX export failed; using built-in biblatex. ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Degrade to Zotero's stock biblatex translator, wherever the library is served from.
      const text = await stockExport('biblatex');
      return {
        content: [
          {
            type: 'text',
            text: `[Better BibTeX unavailable — returned Zotero's built-in biblatex instead. Run desktop Zotero with the Better BibTeX plugin for BBT-specific formatting.]\n\n${text}`,
          },
        ],
        structuredContent: { format: 'biblatex', length: text.length, degradedToBuiltIn: true, text },
      };
    }

    const text = await stockExport(args.format);
    return {
      content: [{ type: 'text', text }],
      // Mirror the raw export into structuredContent so struct-only clients get
      // the payload, not just {format,length}. See `ok()` in registry.ts.
      structuredContent: { format: args.format, length: text.length, text },
    };
  },
};

export default exportTool;

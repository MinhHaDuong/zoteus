import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult, ToolContext } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

async function maybeSave(ctx: ToolContext, args: any, items: any[]): Promise<ToolHandlerResult> {
  if (!args.save_to_library) {
    return ok({ items, count: items.length, saved: false }, `Resolved ${items.length} item(s) (not saved to library).`);
  }
  const lib = requireCloudLibrary(ctx, args);
  if (args.collection_key) {
    for (const it of items) it.collections = [...(it.collections ?? []), args.collection_key];
  }
  const result = await ctx.web.writeItems(lib, items);
  return ok(
    { created: result.successful.map((s) => s.key), failed: result.failed, resolved: items.length },
    `Imported ${result.successful.length} of ${items.length} resolved item(s) into the library.`,
  );
}

const importTool: ToolDefinition = {
  name: 'zotero_import',
  title: 'Import items by identifier or URL',
  description:
    'Resolve bibliographic metadata from an identifier or web page and optionally save it to your library. `action: "by_identifier"` resolves a DOI, ISBN, PMID, arXiv id, or ADS bibcode (set `identifier`); `action: "by_url"` scrapes a web page (set `url`) and may return multiple choices to pick from. Set `save_to_library:true` (and optionally `collection_key`) to persist the resolved items (requires a cloud API key); otherwise the resolved metadata is returned without saving. Requires a reachable Zotero translation-server (configurable via ZOTEUS_TRANSLATION_SERVER_URL); if none is running, this returns setup instructions.',
  inputSchema: {
    action: z.enum(['by_identifier', 'by_url']),
    identifier: z.string().optional().describe('DOI / ISBN / PMID / arXiv id / ADS bibcode.'),
    url: z.string().optional().describe('Web page URL to scrape.'),
    save_to_library: z.boolean().optional().describe('Persist the resolved items (needs a cloud key).'),
    collection_key: z.string().optional().describe('Collection to add saved items to.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (!(await ctx.translation.isUp())) {
      return err(
        `No Zotero translation-server reachable at ${ctx.config.translationServerUrl}. Start one with \`docker run -d -p 1969:1969 zotero/translation-server\` (or set ZOTEUS_TRANSLATION_SERVER_URL), then retry.`,
      );
    }
    if (args.action === 'by_identifier') {
      if (!args.identifier) return err('`identifier` is required for by_identifier.');
      const items = await ctx.translation.search(args.identifier);
      if (!items.length) return err(`No metadata resolved for "${args.identifier}".`);
      return maybeSave(ctx, args, items);
    }
    // by_url
    if (!args.url) return err('`url` is required for by_url.');
    const result = await ctx.translation.web(args.url);
    if (result.multiple) {
      return ok(
        { multiple: result.multiple },
        `The page offers multiple items. Inspect "multiple.items" (key->label) and re-run with a more specific URL, or save a chosen item.`,
      );
    }
    const items = result.items ?? [];
    if (!items.length) return err(`No items found at ${args.url}.`);
    return maybeSave(ctx, args, items);
  },
};

export default importTool;

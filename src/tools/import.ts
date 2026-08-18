import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult, ToolContext } from '../registry/registry.js';
import { ok, requireCloudLibrary, isLocalWritesUnavailable, ensureLocalApi } from '../registry/registry.js';
import { arxivItem, fromScholarWork, parseIdentifier, bareDoi, type ResolvedItem } from '../features/resolve/resolve.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Built-in resolution fallback used when no translation-server is reachable.
 * Handles arXiv ids (direct Atom fetch) and DOIs (OpenAlex primary, Crossref
 * fallback — the same scholar providers zotero_scholar uses). ISBN/PMID/
 * bibcodes and web URLs cannot be resolved server-side and return a clear error.
 */
async function resolveBuiltin(ctx: ToolContext, id: string): Promise<{ items: ResolvedItem[]; source: string }> {
  const parsed = parseIdentifier(id);
  if (!parsed) {
    throw new Error(
      `Could not parse "${id}" as a known identifier. Try a DOI (10.…), arXiv id (YYMM.NNNNN), ISBN, PMID, or ADS bibcode — or start a translation-server for URL imports.`,
    );
  }
  switch (parsed.type) {
    case 'arxiv': {
      const item = await arxivItem(parsed.value, (url, init) => ctx.fetcher.fetch(url, init, { maxRetries: 0, deadlineMs: 60_000 }));
      if (!item) throw new Error(`arXiv returned no record for "${parsed.value}".`);
      return { items: [item], source: 'arxiv' };
    }
    case 'doi': {
      const doi = bareDoi(parsed.value);
      const work = await ctx.scholar.lookup(doi);
      if (!work) throw new Error(`No scholarly record found for DOI "${doi}".`);
      return { items: [fromScholarWork(work, doi)], source: 'scholar' };
    }
    case 'pmid':
      throw new Error(`PMID resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    case 'isbn':
      throw new Error(`ISBN resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    case 'bibcode':
      throw new Error(`ADS bibcode resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    default:
      throw new Error(`Unsupported identifier type "${parsed.type}".`);
  }
}

const importTool: ToolDefinition = {
  name: 'zotero_import',
  title: 'Import items by identifier or URL',
  description:
    'Resolve bibliographic metadata to Zotero item-data and optionally save it to your library. `action: "by_identifier"` resolves a DOI, ISBN, PMID, arXiv id, or ADS bibcode (set `identifier`); `action: "by_url"` scrapes a web page (set `url`) and may return multiple choices to pick from. Set `save_to_library:true` (and optionally `collection_key`) to persist the resolved items — saved into the running Zotero desktop app when available, otherwise via the cloud Web API (requires ZOTERO_API_KEY); otherwise the resolved metadata is returned without saving. When a Zotero translation-server is reachable (ZOTEUS_TRANSLATION_SERVER_URL, default http://127.0.0.1:1969) it is the primary path; if none is running, DOI and arXiv ids fall back to built-in resolution (OpenAlex/Crossref and the arXiv API respectively) — the result then carries a `source` field ("scholar" or "arxiv"). ISBN/PMID/bibcode and web URLs require a translation-server.',
  inputSchema: {
    action: z.enum(['by_identifier', 'by_url']),
    identifier: z.string().optional().describe('DOI (10.…), arXiv id (YYMM.NNNNN), ISBN, PMID, or ADS bibcode.'),
    url: z.string().optional().describe('Web page URL to scrape (needs a translation-server).'),
    save_to_library: z.boolean().optional().describe('Persist the resolved items — into the running Zotero desktop app when available, otherwise the cloud Web API (needs a cloud key).'),
    collection_key: z.string().optional().describe('Collection to add saved items to: an 8-char collection key or a Zotero treeViewID like "C20".'),
    attach_url: z.string().url().optional().describe('File URL (e.g. an arXiv PDF) to download and attach as a stored attachment to the (single) imported item when saving to the desktop app.'),
    attach_title: z.string().optional().describe('Title for the attached file, e.g. "Full Text PDF".'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const tsUp = await ctx.translation.isUp();
    if (!tsUp && !args.identifier) {
      // A URL with no translation-server is unresolvable server-side; say so plainly.
      if (args.action === 'by_url') {
        return err(
          `No Zotero translation-server reachable at ${ctx.config.translationServerUrl}, and URL scraping has no built-in fallback. Start one with \`docker run -d -p 1969:1969 zotero/translation-server\` (or set ZOTEUS_TRANSLATION_SERVER_URL), then retry.`,
        );
      }
      return err(
        `No Zotero translation-server reachable at ${ctx.config.translationServerUrl}. DOI/arXiv ids can still be resolved via built-in fallbacks; ISBN/PMID/bibcode and URLs need the server (start it with \`docker run -d -p 1969:1969 zotero/translation-server\`, or set ZOTEUS_TRANSLATION_SERVER_URL).`,
      );
    }
    if (args.action === 'by_identifier') {
      if (!args.identifier) return err('`identifier` is required for by_identifier.');
      if (tsUp) {
        const items = await ctx.translation.search(args.identifier);
        if (items.length) return await maybeSave(ctx, args, items, 'translation-server');
      }
      // translation-server down (or the identifier failed): try the built-in path.
      try {
        const { items, source } = await resolveBuiltin(ctx, args.identifier);
        return await maybeSave(ctx, args, items, source);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
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
    return await maybeSave(ctx, args, items, 'translation-server');
  },
};

/** Save resolved items, tagging the resolution source for provenance. */
async function maybeSave(ctx: ToolContext, args: any, items: any[], source: string): Promise<ToolHandlerResult> {
  const tagged = items.map((it) => ({
    ...it,
    extra: [it?.extra, `resolved:${source}`].filter(Boolean).join('\n'),
  }));
  const payload = tagged;
  if (!args.save_to_library) {
    return ok(
      { items: payload, count: payload.length, saved: false, source },
      `Resolved ${payload.length} item(s) via ${source} (not saved to library).`,
    );
  }
  // Prefer the desktop app for the personal library (no cloud key needed);
  // fall back to the cloud Web API otherwise.
  if (!args.library_id && (await ensureLocalApi(ctx)) && ctx.localWrites) {
    try {
      if (args.collection_key) {
        for (const it of payload) it.collections = [...(it.collections ?? []), args.collection_key];
      }
      const result = await ctx.localWrites.writeItems(payload);
      return ok(
        { created: result.successful.map((s) => s.key), failed: result.failed, resolved: payload.length, source, target: 'local' },
        `Imported ${result.successful.length} of ${payload.length} resolved item(s) via ${source} into the library (Zotero desktop).`,
      );
    } catch (e) {
      if (!isLocalWritesUnavailable(e)) throw e;
      ctx.logger.info(`Local-API writes unavailable (${e instanceof Error ? e.message : e}); using the connector protocol.`);
    }
  }
  if (!args.library_id && ctx.connectorWrites && (await ensureLocalApi(ctx))) {
    // Connector protocol: collections are targeted by treeViewID via updateSession,
    // not by the collections array, so strip it from the payload.
    const stripped = payload.map(({ collections: _c, ...rest }) => rest);
    const { sessionID, connectorIds } = await ctx.connectorWrites.saveItems(stripped, {
      uri: 'zotero://zoteus/import',
    });
    let placedIn: string | undefined;
    if (args.collection_key) {
      try {
        const target = await resolveTreeViewId(ctx, args.collection_key);
        if (target) {
          await ctx.connectorWrites.updateSession(sessionID, { target });
          placedIn = target;
        }
      } catch (e) {
        return ok(
          { sessionID, resolved: stripped.length, source, target: 'desktop', warning: String(e) },
          `Saved ${stripped.length} item(s) via ${source}, but could not place them in "${args.collection_key}": ${e}`,
        );
      }
    }
    let attached: { bytes: number; contentType: string } | undefined;
    if (args.attach_url && connectorIds[0]) {
      const res = await ctx.fetcher.fetch(args.attach_url, { method: 'GET' }, { maxRetries: 2, deadlineMs: 300_000 });
      if (!res.ok) {
        return ok(
          { sessionID, resolved: stripped.length, source, target: 'desktop', warning: `File download failed (${res.status}) for ${args.attach_url}` },
          `Saved ${stripped.length} item(s) via ${source}; attachment download failed (${res.status}).`,
        );
      }
      const contentType = res.headers.get('content-type')?.split(';')[0] ?? 'application/pdf';
      const bytes = new Uint8Array(await res.arrayBuffer());
      await ctx.connectorWrites.saveAttachment({
        sessionID,
        parentConnectorId: connectorIds[0],
        url: args.attach_url,
        title: args.attach_title ?? 'Full Text PDF',
        bytes,
        contentType,
      });
      attached = { bytes: bytes.length, contentType };
    }
    const created = await pollImportedItems(ctx, stripped);
    return ok(
      {
        sessionID,
        created,
        resolved: stripped.length,
        source,
        target: 'desktop',
        placedIn,
        attached,
        note: created.length < stripped.length
          ? 'Some items could not be matched back yet; they may still appear in Zotero.'
          : undefined,
      },
      `Imported ${created.length}/${stripped.length} resolved item(s) via ${source} into the running Zotero desktop app` +
        (placedIn ? ` (collection ${placedIn})` : '') +
        (attached ? `, with ${attached.bytes}-byte PDF attached` : '') + '.',
    );
  }
  if (args.collection_key) {
    for (const it of payload) it.collections = [...(it.collections ?? []), args.collection_key];
  }
  let lib: ReturnType<typeof requireCloudLibrary>;
  try {
    lib = requireCloudLibrary(ctx, args);
  } catch (e) {
    return {
      content: [{
        type: 'text',
        text: `${e instanceof Error ? e.message : e} Tip: with the Zotero desktop app running, saving needs no cloud key — start the app (or set ZOTEUS_LOCAL=on) and retry.`,
      }],
      isError: true,
    };
  }
  const result = await ctx.web.writeItems(lib, payload);
  return ok(
    {
      created: result.successful.map((s) => s.key),
      failed: result.failed,
      resolved: payload.length,
      source,
      target: 'cloud',
      warning: args.attach_url ? 'attach_url is only supported for desktop-app saves; the file was not attached.' : undefined,
    },
    `Imported ${result.successful.length} of ${payload.length} resolved item(s) via ${source} into the library.`,
  );
}

export default importTool;


/**
 * Resolve a caller-supplied collection to the connector protocol's treeViewID
 * ("L1" for My Library, "C<id>" for collections). Accepts a treeViewID directly,
 * or an 8-char collection key that is matched by name against the app's target list.
 */
async function resolveTreeViewId(ctx: ToolContext, collectionKey: string): Promise<string | undefined> {
  if (/^[CL]\d+$/.test(collectionKey)) return collectionKey;
  const collections = await ctx.router.listCollections({ limit: 1000 });
  const match = collections.data
    .map((c: any) => c?.data ?? c)
    .find((c: any) => c?.key === collectionKey);
  if (!match) throw new Error(`Collection key ${collectionKey} not found in the library.`);
  const { targets } = await ctx.connectorWrites!.getSelectedCollection();
  const byName = targets.filter((t) => t.name === match.name);
  if (!byName.length) return undefined;
  if (byName.length > 1) {
    throw new Error(
      `Multiple collections named "${match.name}" exist (${byName.map((t) => t.id).join(', ')}); pass an explicit treeViewID instead.`,
    );
  }
  return byName[0]?.id;
}

/** Recover the keys of items just saved through the connector protocol (no payload). */
async function pollImportedItems(ctx: ToolContext, sent: Record<string, unknown>[]): Promise<string[]> {
  const found: string[] = [];
  const deadline = Date.now() + 15_000;
  const wanted = new Set(sent.map((it) => String(it.title ?? '')));
  while (wanted.size && Date.now() < deadline) {
    try {
      const res = await ctx.local!.listItems({ sort: 'dateAdded', direction: 'desc', limit: 25 } as any);
      for (const item of res.data) {
        const d = item?.data ?? item;
        const title = String(d?.title ?? '');
        if (wanted.has(title)) {
          wanted.delete(title);
          found.push(d.key);
        }
      }
    } catch {
      // Keep polling until the deadline.
    }
    if (wanted.size) await new Promise((r) => setTimeout(r, 750));
  }
  return found;
}

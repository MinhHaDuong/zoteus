import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';
import {
  auditOffTaxonomy,
  auditMissingTiers,
  type Vocabulary,
  type TagInfo,
  type AuditItem,
} from '../features/tags/audit.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const vocabSchema = z.object({
  tags: z.array(z.object({ name: z.string(), tier: z.string().optional() })),
  tiers: z.array(z.object({ name: z.string(), required: z.boolean().optional() })).optional(),
});

async function listAllTags(ctx: ToolContext, lib: LibraryRef): Promise<TagInfo[]> {
  const out: TagInfo[] = [];
  let start = 0;
  const limit = 100;
  for (;;) {
    const r = await ctx.web.listTags(lib, { limit, start });
    for (const t of r.data) {
      if (typeof t === 'string') out.push({ name: t, auto: false });
      else out.push({ name: t.tag, numItems: t.meta?.numItems, auto: t.meta?.type === 1 }); // Zotero: type 1 = automatic
    }
    start += r.data.length;
    if (!r.data.length || start >= r.totalResults) break;
  }
  return out;
}

async function listItems(
  ctx: ToolContext,
  library: LibraryRef | undefined,
  collectionKey?: string,
): Promise<AuditItem[]> {
  const out: AuditItem[] = [];
  let start = 0;
  const limit = 100;
  for (;;) {
    const r = await ctx.router.searchItems({ top: true, limit, start, collectionKey, library });
    for (const it of r.data) {
      const d = it.data ?? it;
      if (d.itemType === 'attachment' || d.itemType === 'note') continue;
      out.push({ key: it.key ?? d.key, title: d.title, tags: (d.tags ?? []).map((t: any) => t.tag) });
    }
    start += r.data.length;
    if (!r.data.length || start >= r.totalResults) break;
  }
  return out;
}

const tagAudit: ToolDefinition = {
  name: 'zotero_tag_audit',
  title: 'Audit tags against a controlled vocabulary',
  description:
    'Audit a library against a controlled tag vocabulary with priority tiers. Provide the vocabulary inline as `vocabulary` (or a JSON file via `vocabulary_path`): { tags:[{name,tier?}], tiers?:[{name,required?}] }. Reports (1) off-taxonomy tags (library tags not in the vocabulary; Zotero auto-applied tags are bucketed separately unless include_auto), (2) items missing a tag from each required tier, and (3) optional per-collection coverage when `scope.collection_keys` is given. Read-only. Tag/auto-tag enumeration uses the cloud Web API.',
  inputSchema: {
    vocabulary: vocabSchema.optional(),
    vocabulary_path: z.string().optional().describe('Path to a JSON file with the vocabulary.'),
    scope: z.object({ collection_keys: z.array(z.string()).optional() }).optional(),
    include_auto: z.boolean().optional().describe('Treat Zotero auto-applied tags as off-taxonomy too.'),
    limit: z.number().int().min(1).max(500).optional().describe('Max items listed per report (default 50).'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    let vocab: Vocabulary;
    if (args.vocabulary && args.vocabulary_path) return err('Provide only one of `vocabulary` or `vocabulary_path`.');
    if (args.vocabulary) vocab = args.vocabulary;
    else if (args.vocabulary_path) {
      const raw = await readFile(args.vocabulary_path, 'utf8').catch(() => null);
      if (raw == null) return err(`Could not read vocabulary file: ${args.vocabulary_path}`);
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return err(`Vocabulary file is not valid JSON: ${args.vocabulary_path}`);
      }
      const parsed = vocabSchema.safeParse(json);
      if (!parsed.success) return err(`Vocabulary file is invalid: ${parsed.error.message}`);
      vocab = parsed.data;
    } else return err('Provide a `vocabulary` object or a `vocabulary_path`.');

    const library: LibraryRef | undefined = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : undefined;
    const lib = library ?? ctx.router.defaultLibrary();
    const cap = args.limit ?? 50;

    const libraryTags = await listAllTags(ctx, lib);
    const { offTaxonomy, autoTags } = auditOffTaxonomy(libraryTags, vocab, Boolean(args.include_auto));

    const items = await listItems(ctx, library);
    const missingByTier = auditMissingTiers(items, vocab).map((m) => ({
      tier: m.tier,
      itemCount: m.itemCount,
      items: m.items.slice(0, cap),
      omitted: Math.max(0, m.itemCount - cap),
    }));

    const collections: Array<{ collectionKey: string; missingByTier: typeof missingByTier }> = [];
    for (const ck of args.scope?.collection_keys ?? []) {
      const colItems = await listItems(ctx, library, ck);
      collections.push({
        collectionKey: ck,
        missingByTier: auditMissingTiers(colItems, vocab).map((m) => ({
          tier: m.tier,
          itemCount: m.itemCount,
          items: m.items.slice(0, cap),
          omitted: Math.max(0, m.itemCount - cap),
        })),
      });
    }

    const summary =
      `Audited ${libraryTags.length} tag(s) over ${items.length} item(s): ` +
      `${offTaxonomy.length} off-taxonomy, ${autoTags.length} auto, ` +
      `${missingByTier.reduce((n, m) => n + m.itemCount, 0)} required-tier gap(s).`;
    return ok(
      {
        offTaxonomy: offTaxonomy.slice(0, cap),
        offTaxonomyTotal: offTaxonomy.length,
        autoTags: autoTags.slice(0, cap),
        autoTagsTotal: autoTags.length,
        missingByTier,
        collections: collections.length ? collections : undefined,
        itemsScanned: items.length,
      },
      summary,
    );
  },
};

export default tagAudit;

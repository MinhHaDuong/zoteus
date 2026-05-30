import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';
import { ZoteroApiError } from '../api/errors.js';

function versionOf(item: any): number | undefined {
  return item?.version ?? item?.data?.version;
}

const updateItem: ToolDefinition = {
  name: 'zotero_update_item',
  title: 'Update a Zotero item',
  description:
    'Partially update one item (HTTP PATCH — only the fields you supply change; omitted fields are preserved). Provide `item_key` and a `patch` object of the fields to change (e.g. {"title":"New","extra":"note"} or {"tags":[{"tag":"reviewed"}]}). Optimistic concurrency is handled for you: if you pass the item\'s `version` it is used; otherwise the current version is fetched first. If the item changed on the server in the meantime (412), the update is automatically re-fetched and retried once. Writes go to the cloud Web API. Set `dry_run:true` to preview the field-level before→after diff without writing (arrays like tags/collections are replaced wholesale by PATCH, not merged).',
  inputSchema: {
    item_key: z.string().describe('The 8-character item key.'),
    patch: z.record(z.any()).describe('Object of fields to change (PATCH semantics).'),
    version: z.number().int().optional().describe('Known current version; fetched automatically if omitted.'),
    dry_run: z.boolean().optional().describe('Preview the field-level before→after diff without writing.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = requireCloudLibrary(ctx, args);
    if (args.dry_run) {
      const item = await ctx.web.getItem(lib, args.item_key);
      const before = (item?.data ?? {}) as Record<string, unknown>;
      const version = versionOf(item);
      const diff: Record<string, { before: unknown; after: unknown }> = {};
      const arrayReplacements: string[] = [];
      for (const [k, v] of Object.entries(args.patch ?? {})) {
        if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
        diff[k] = { before: before[k], after: v };
        if (Array.isArray(v) || Array.isArray(before[k])) arrayReplacements.push(k);
      }
      const n = Object.keys(diff).length;
      return ok(
        { item_key: args.item_key, version, dryRun: true, diff, arrayReplacements },
        n
          ? `Dry run for ${args.item_key}: ${n} field(s) would change` +
            (arrayReplacements.length ? `; arrays replaced wholesale: ${arrayReplacements.join(', ')}.` : '.')
          : `Dry run for ${args.item_key}: no changes.`,
      );
    }
    let version = args.version;
    if (version == null) {
      version = versionOf(await ctx.web.getItem(lib, args.item_key));
    }
    if (version == null) {
      return {
        content: [{ type: 'text', text: `Could not determine the current version of ${args.item_key}.` }],
        isError: true,
      };
    }
    try {
      const newVersion = await ctx.web.patchItem(lib, args.item_key, args.patch, version);
      return ok({ item_key: args.item_key, newVersion }, `Updated ${args.item_key} (now version ${newVersion}).`);
    } catch (err) {
      if (err instanceof ZoteroApiError && err.status === 412) {
        const fresh = versionOf(await ctx.web.getItem(lib, args.item_key));
        if (fresh == null) throw err;
        const newVersion = await ctx.web.patchItem(lib, args.item_key, args.patch, fresh);
        return ok(
          { item_key: args.item_key, newVersion, retried: true },
          `Updated ${args.item_key} after a version conflict (now version ${newVersion}).`,
        );
      }
      throw err;
    }
  },
};

export default updateItem;

import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';
import { uploadFile, downloadFile } from '../api/attachments.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const attachment: ToolDefinition = {
  name: 'zotero_attachment',
  title: 'Zotero attachments (files)',
  description:
    "Upload, download, or inspect attachment files. `action`: \"upload\" stores a local file as a Zotero attachment using the full File Storage protocol (provide `file_path`; optional `parent_item` to attach it under an item, `title`, `content_type`) and returns the new attachment key; \"download\" fetches an attachment's file to a local path (provide `item_key`; optional `save_path`, default under the Zoteus data dir) and returns the path and byte count; \"info\" returns an attachment item's metadata. File bytes are written to / read from disk — they are never streamed through the conversation. Upload/download use the cloud Web API and your file-storage quota.",
  inputSchema: {
    action: z.enum(['upload', 'download', 'info']),
    file_path: z.string().optional().describe('Local file to upload.'),
    parent_item: z.string().optional().describe('Parent item key to attach under (upload).'),
    title: z.string().optional(),
    content_type: z.string().optional(),
    item_key: z.string().optional().describe('Attachment item key (download/info).'),
    save_path: z.string().optional().describe('Where to write the downloaded file.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'info') {
      if (!args.item_key) return err('`item_key` is required for info.');
      const library = args.library_id
        ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
        : undefined;
      const item = await ctx.router.getItem(args.item_key, { library });
      return ok({ attachment: item }, `Attachment ${args.item_key}: ${item?.data?.filename ?? item?.data?.title ?? '(unnamed)'}.`);
    }

    const lib = requireCloudLibrary(ctx, args);

    if (args.action === 'upload') {
      if (!args.file_path) return err('`file_path` is required for upload.');
      const result = await uploadFile(ctx.web, lib, {
        filePath: args.file_path,
        parentItem: args.parent_item,
        title: args.title,
        contentType: args.content_type,
      });
      const msg = result.exists
        ? `File already in storage; attachment item ${result.key} created for ${result.filename}.`
        : `Uploaded ${result.filename} as attachment ${result.key}.`;
      return ok({ key: result.key, exists: result.exists, filename: result.filename }, msg);
    }

    // download
    if (!args.item_key) return err('`item_key` is required for download.');
    const savePath = args.save_path ?? join(ctx.config.dataDir, 'attachments', args.item_key);
    await mkdir(dirname(savePath), { recursive: true });
    const r = await downloadFile(ctx.web, lib, args.item_key, savePath);
    return ok(
      { savePath: r.savePath, bytes: r.bytes, contentType: r.contentType },
      `Downloaded ${r.bytes} bytes to ${r.savePath}.`,
    );
  },
};

export default attachment;

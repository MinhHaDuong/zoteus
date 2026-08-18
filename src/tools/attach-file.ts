import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, ensureLocalApi } from '../registry/registry.js';

/**
 * Attach a file (local path or URL) to an item as a stored (imported_file)
 * attachment. Requires the Zotero desktop app (Zotero 9+ local API writes), since
 * the cloud client here does not implement the storage upload flow.
 */
const attachFile: ToolDefinition = {
  name: 'zotero_attach_file',
  title: 'Attach a file (PDF, snapshot) to an item',
  description:
    'Add a stored file attachment (e.g. a PDF full text) under an existing item. Give `parent` (the item key) and either `path` (a local file the Zoteus process can read) or `url` (downloaded first). `filename` and `content_type` are inferred when omitted. Runs against the Zotero desktop app\u2019s local API (Zotero 9+; you may be asked once to allow Zoteus write access — choose "Always Allow"). Returns the new attachment key.',
  inputSchema: {
    parent: z.string().describe('Key of the parent item to attach the file to.'),
    path: z.string().optional().describe('Local filesystem path to the file.'),
    url: z.string().url().optional().describe('URL to download the file from.'),
    filename: z.string().optional().describe('File name to store; inferred from path/url if omitted.'),
    content_type: z.string().optional().describe('MIME type; inferred from the extension if omitted (pdf -> application/pdf).'),
    title: z.string().optional().describe('Attachment title, e.g. "Full Text PDF".'),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (!ctx.localWrites || !(await ensureLocalApi(ctx))) {
      return {
        content: [{ type: 'text', text: 'Storing files needs Zotero desktop write access. If your Zotero has the upcoming local-API writes, provide a key via ZOTEUS_LOCAL_API_KEY (or grant it once); on current Zotero versions, attach files DURING import instead — zotero_import supports `attach_url`, which streams the file into the same save session. Otherwise set ZOTERO_API_KEY and use the cloud flow.' }],
        isError: true,
      };
    }
    if (!args.path && !args.url) {
      return { content: [{ type: 'text', text: 'Provide `path` or `url`.' }], isError: true };
    }

    let bytes: Uint8Array;
    let inferredName: string;
    if (args.path) {
      bytes = new Uint8Array(await readFile(args.path));
      inferredName = args.path.split(/[\\/]/).pop() ?? 'attachment';
    } else {
      const res = await ctx.fetcher.fetch(args.url, { method: 'GET' }, { maxRetries: 2, deadlineMs: 300_000 });
      if (!res.ok) {
        return { content: [{ type: 'text', text: `Download failed (${res.status}) for ${args.url}` }], isError: true };
      }
      bytes = new Uint8Array(await res.arrayBuffer());
      const noQuery = args.url.split('?')[0] ?? args.url;
      inferredName = decodeURIComponent(noQuery.split('/').pop() ?? 'attachment');
    }
    const filename = args.filename ?? inferredName;
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const contentType =
      args.content_type ??
      (ext === 'pdf' ? 'application/pdf' : ext === 'html' || ext === 'htm' ? 'text/html' : 'application/octet-stream');

    // 1) Create the attachment item, 2) upload + register the file bytes.
    const result = await ctx.localWrites.writeItems([
      {
        itemType: 'attachment',
        parentItem: args.parent,
        linkMode: 'imported_file',
        title: args.title ?? filename,
        contentType,
        tags: [],
      },
    ]);
    if (result.failed.length || !result.successful.length) {
      return { content: [{ type: 'text', text: `Could not create attachment item: ${JSON.stringify(result.failed)}` }], isError: true };
    }
    const attachmentKey = result.successful[0]?.key;
    if (!attachmentKey) {
      return { content: [{ type: 'text', text: 'Local write returned no attachment key.' }], isError: true };
    }
    await ctx.localWrites.uploadFile(attachmentKey, { bytes, filename, contentType });
    return ok(
      { attachment: attachmentKey, parent: args.parent, filename, bytes: bytes.length, contentType, target: 'local' },
      `Attached ${filename} (${bytes.length} bytes) to item ${args.parent} as ${attachmentKey}.`,
    );
  },
};

export default attachFile;

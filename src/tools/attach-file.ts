import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, ensureLocalApi } from '../registry/registry.js';
import {
  AttachmentDownloadError,
  bareFilename,
  downloadAttachment,
  resolveContentType,
  storeLocalAttachment,
} from '../features/attachments/store.js';

/**
 * Attach a file (local path or URL) to an item as a stored (imported_file)
 * attachment. Requires the Zotero desktop app (Zotero 10+ local API writes), since
 * the cloud client here does not implement the storage upload flow.
 */
const attachFile: ToolDefinition = {
  name: 'zotero_attach_file',
  title: 'Attach a file (PDF, snapshot) to an item',
  description:
    'Add a stored file attachment (e.g. a PDF full text) under an existing item. Give `parent` (the item key) and either `path` (a local file the Zoteus process can read) or `url` (downloaded first). `filename` and `content_type` are inferred when omitted. Runs against the Zotero desktop app\u2019s local API (Zotero 10+; you may be asked once to allow Zoteus write access — choose "Always Allow"). Returns the new attachment key.',
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
        content: [{ type: 'text', text: 'Storing files needs Zotero desktop write access, which the local API provides from Zotero 10. Grant it once when Zotero asks (or pre-provision ZOTEUS_LOCAL_API_KEY). On Zotero 9 and earlier, attach files DURING import instead — zotero_import supports `attach_url`, which streams the file into the same save session. Otherwise set ZOTERO_API_KEY and use the cloud flow.' }],
        isError: true,
      };
    }
    if (!args.path && !args.url) {
      return { content: [{ type: 'text', text: 'Provide `path` or `url`.' }], isError: true };
    }

    let bytes: Uint8Array;
    let inferredName: string;
    let served: string | undefined;
    if (args.path) {
      bytes = new Uint8Array(await readFile(args.path));
      inferredName = bareFilename(args.path);
    } else {
      try {
        const file = await downloadAttachment(ctx, args.url);
        ({ bytes, contentType: served } = file);
        inferredName = file.filename;
      } catch (e) {
        if (!(e instanceof AttachmentDownloadError)) throw e;
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    }
    const filename = bareFilename(args.filename ?? inferredName, inferredName);
    const contentType = resolveContentType(filename, { explicit: args.content_type, served });

    // 1) Create the attachment item, 2) upload + register the file bytes. A refusal
    //    from Zotero surfaces as a tool error through the registry's error mapping.
    const attachmentKey = await storeLocalAttachment(ctx, {
      parent: args.parent,
      bytes,
      filename,
      contentType,
      title: args.title,
      url: args.url,
    });
    return ok(
      { attachment: attachmentKey, parent: args.parent, filename, bytes: bytes.length, contentType, target: 'local' },
      `Attached ${filename} (${bytes.length} bytes) to item ${args.parent} as ${attachmentKey}.`,
    );
  },
};

export default attachFile;

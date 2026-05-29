import { callMCPTool } from '../runtime.js';

/**
 * Zotero attachments (files) — Upload, download, or inspect attachment files. `action`: "upload" stores a local file as a Zotero attachment using the full File Storage protocol (provide `file_path`; optional `parent_item` to attach it under an item, `title`, `content_type`) and returns the new attachment key; "download" fetches an attachment's file to a local path (provide `item_key`; optional `save_path`, default under the Zoteus data dir) and returns the path and byte count; "info" returns an attachment item's metadata. File bytes are written to / read from disk — they are never streamed through the conversation. Upload/d
 * Params: action, file_path, parent_item, title, content_type, item_key, save_path, library_type, library_id.
 */
export function attachment(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_attachment', input);
}

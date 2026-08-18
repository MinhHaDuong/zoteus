import { callMCPTool } from '../runtime.js';

/**
 * Attach a file (PDF, snapshot) to an item — Add a stored file attachment (e.g. a PDF full text) under an existing item. Give `parent` (the item key) and either `path` (a local file the Zoteus process can read) or `url` (downloaded first). `filename` and `content_type` are inferred when omitted. Runs against the Zotero desktop app’s local API (Zotero 10+; you may be asked once to allow Zoteus write access — choose "Always Allow"). Returns the new attachment key.
 * Params: parent, path, url, filename, content_type, title.
 */
export function attachFile(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_attach_file', input);
}

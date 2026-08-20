import { callMCPTool } from '../runtime.js';

/**
 * Attach a file (PDF, snapshot) to an item — Add a stored file attachment (e.g. a PDF full text) under an existing item. Give `parent` (the item key) and either `url` (Zoteus downloads it, then stores it) or `path` (a file on the machine running Zoteus). `filename` and `content_type` are inferred when omitted. Saves through the Zotero desktop app when one is reachable (Zotero 10+ local API; you may be asked once to allow Zoteus write access, choose "Always Allow"), and otherwise through the cloud Web API, which needs ZOTERO_API_KEY with file access and uses your Zotero file-storage quota. `url` works on every setup including a remote/hos
 * Params: parent, path, url, filename, content_type, title, library_type, library_id.
 */
export function attachFile(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_attach_file', input);
}

import { callMCPTool } from '../runtime.js';

/**
 * Import items by identifier or URL — Resolve bibliographic metadata to Zotero item-data and optionally save it to your library. `action: "by_identifier"` resolves a DOI, ISBN, PMID, arXiv id, or ADS bibcode (set `identifier`); `action: "by_url"` scrapes a web page (set `url`) and may return multiple choices to pick from. Set `save_to_library:true` (and optionally `collection_key`) to persist the resolved items — saved into the running Zotero desktop app when available, otherwise via the cloud Web API (requires ZOTERO_API_KEY); otherwise the resolved metadata is returned without saving. When a Zotero translation-server is reachabl
 * Params: action, identifier, url, save_to_library, collection_key, attach_url, attach_title, library_type, library_id.
 */
export function importTool(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_import', input);
}

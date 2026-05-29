import { callMCPTool } from '../runtime.js';

/**
 * Import items by identifier or URL — Resolve bibliographic metadata from an identifier or web page and optionally save it to your library. `action: "by_identifier"` resolves a DOI, ISBN, PMID, arXiv id, or ADS bibcode (set `identifier`); `action: "by_url"` scrapes a web page (set `url`) and may return multiple choices to pick from. Set `save_to_library:true` (and optionally `collection_key`) to persist the resolved items (requires a cloud API key); otherwise the resolved metadata is returned without saving. Requires a reachable Zotero translation-server (configurable via ZOTEUS_TRANSLATION_SERVER_URL); if none is running, this re
 * Params: action, identifier, url, save_to_library, collection_key, library_type, library_id.
 */
export function importTool(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_import', input);
}

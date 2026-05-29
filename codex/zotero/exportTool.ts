import { callMCPTool } from '../runtime.js';

/**
 * Export Zotero items — Export items in a bibliographic format and return the raw text. Choose `format` (bibtex, biblatex, ris, csljson, csv, mods, tei, coins, rdf_*, refer, wikipedia, bookmarks). Narrow the set with `item_keys`, `collection_key`, `q`, or `item_type`. A `limit` is always applied (default 50) because export formats require it. For a styled human bibliography (CSL styles like APA/IEEE) use the dedicated bibliography tools instead; this is for machine-readable reference formats. Reads via the cloud Web API.
 * Params: format, item_keys, collection_key, q, item_type, limit, library_type, library_id.
 */
export function exportTool(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_export', input);
}

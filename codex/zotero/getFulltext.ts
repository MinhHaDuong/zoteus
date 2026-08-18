import { callMCPTool } from '../runtime.js';

/**
 * Get attachment full text / passages (read-only) — Retrieve an item's PDF text for grounding. Pass a parent `item_key` (its best PDF attachment is resolved automatically) or an attachment key. With `query`, returns the top relevant passages with locators (char offsets, nearest section, and a page); with `page_range` (e.g. "3-7"), returns that span; with neither, returns a truncated head. Text comes from Zotero's full-text index when available; when the attachment is NOT indexed yet, the PDF itself is downloaded and parsed on the fly (`fallback`, on by default — set `fallback:false` to disable), so unindexed PDFs still return text (marked fullt
 * Params: item_key, query, page_range, max_passages, max_chars, precise_pages, fallback, library_type, library_id.
 */
export function getFulltext(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_get_fulltext', input);
}

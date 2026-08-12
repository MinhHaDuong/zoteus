import { callMCPTool } from '../runtime.js';

/**
 * Get attachment full text / passages (read-only) — Retrieve an item's PDF text for grounding. Pass a parent `item_key` (its best PDF attachment is resolved automatically) or an attachment key. With `query`, returns the top relevant passages with locators (char offsets, nearest section, and a page); with `page_range` (e.g. "3-7"), returns that span; with neither, returns a truncated head. Page numbers are an estimate (pageApprox) unless `precise_pages:true`, which re-extracts the PDF for exact pages when possible (otherwise it degrades to approximate with a notice). Read-only; cloud full text. Use this to cite a claim with a page after finding 
 * Params: item_key, query, page_range, max_passages, max_chars, precise_pages, library_type, library_id.
 */
export function getFulltext(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_get_fulltext', input);
}

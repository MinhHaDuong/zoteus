import { callMCPTool } from '../runtime.js';

/**
 * Semantic / hybrid library search — Search the library by meaning, not just keywords. Combines BM25 keyword scoring with vector similarity (when an embedding provider is configured) via reciprocal-rank fusion, and returns the best-matching items with a snippet and score. `mode`: "auto" (hybrid, default), "keyword" (BM25 only), or "semantic" (vector only). Requires the index to be built first with zotero_index (action:"build"); if it is empty, this returns guidance to build it. For exact field/tag/itemType filtering use zotero_search_items instead; use this for conceptual/"papers about X" queries.
 * Params: q, limit, mode.
 */
export function semanticSearch(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_semantic_search', input);
}

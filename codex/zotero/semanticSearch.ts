import { callMCPTool } from '../runtime.js';

/**
 * Semantic / hybrid library search — Search the library by meaning, not just keywords. Combines BM25 keyword scoring with vector similarity (when an embedding provider is configured) via reciprocal-rank fusion, and returns the best-matching items with a snippet and score. `mode`: "auto" (hybrid, default), "keyword" (BM25 only), or "semantic" (vector only). The index must be built once before first use: when it is empty this tool starts a background build automatically (`auto_build`, on by default) and tells you to poll zotero_index action:"status" and retry — pass `auto_build:false` to opt out. For exact field/tag/itemType filter
 * Params: q, limit, mode, auto_build.
 */
export function semanticSearch(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_semantic_search', input);
}

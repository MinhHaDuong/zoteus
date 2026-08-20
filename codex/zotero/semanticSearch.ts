import { callMCPTool } from '../runtime.js';

/**
 * Semantic / hybrid library search — Search the library by meaning, not just keywords. Combines BM25 keyword scoring with vector similarity (when an embedding provider is configured) via reciprocal-rank fusion, and returns the best-matching items with a snippet and score. By default it searches item metadata and abstracts; if the index was built with `fulltext` on (zotero_index fulltext:true, or ZOTEUS_INDEX_FULLTEXT=true) it also searches the body text of attachments, and a hit whose snippet came from a PDF body is marked source:"fulltext". `mode`: "auto" (hybrid, default), "keyword" (BM25 only), or "semantic" (vector only). "se
 * Params: q, limit, mode, auto_build.
 */
export function semanticSearch(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_semantic_search', input);
}

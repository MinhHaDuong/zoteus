import { callMCPTool } from '../runtime.js';

/**
 * Build the semantic search index — Manage the local hybrid-search index used by zotero_semantic_search. The build runs as a background job on the server, so this tool returns immediately — never blocks on large libraries. `action: "build"` (or "refresh") starts a background build: it pages the library's top-level items (100-at-a-time, stopping at the server's item cap, ZOTEUS_INDEX_MAX_ITEMS, default 5000, or at a smaller `limit` if one is given), indexes their text (title, abstract, creators, tags) for BM25 keyword search and — if an embedding provider is configured — vector search, persisting partial progress atomically as it
 * Params: action, library_type, library_id, limit, fulltext, fulltext_max_chars.
 */
export function index(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_index', input);
}

import { callMCPTool } from '../runtime.js';

/**
 * Build the semantic search index — Manage the local hybrid-search index used by zotero_semantic_search. The build runs as a background job on the server, so this tool returns immediately — never blocks on large libraries. `action: "build"` (or "refresh") starts a background build: it pages the library's top-level items (100-at-a-time, capped at 5000 items unless a smaller `limit` is given), indexes their text (title, abstract, creators, tags) for BM25 keyword search and — if an embedding provider is configured — vector search, persisting partial progress atomically as it goes. Start a build, then POLL `action: "status"` every f
 * Params: action, library_type, library_id, limit.
 */
export function index(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_index', input);
}

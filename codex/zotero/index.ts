import { callMCPTool } from '../runtime.js';

/**
 * Build the semantic search index — Build, refresh, or report the status of the local hybrid-search index used by zotero_semantic_search. `action: "build"` (or "refresh") fetches the library's top-level items and indexes their text (title, abstract, creators, tags) for BM25 keyword search and — if an embedding provider is configured — vector search; the index is persisted under the Zoteus data dir. `action: "status"` reports the index size and which embedder is active (it falls back to keyword-only when no local model or embedding API is available). Run a build before semantic searching, and refresh after large library changes.
 * Params: action, library_type, library_id.
 */
export function index(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_index', input);
}

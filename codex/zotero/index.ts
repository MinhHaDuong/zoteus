import { callMCPTool } from '../runtime.js';

/**
 * Build the semantic search index — Manage the local hybrid-search index used by zotero_semantic_search. Every job runs in the background on the server, so this tool returns immediately and never blocks on large libraries. THREE write actions, and picking the right one matters: `action: "update"` is the cheap one and should be the default for a library that is already indexed; `action: "build"` and its alias `action: "refresh"` both rebuild the WHOLE index from scratch, which on a large library means many minutes and, with an API embedding provider, real spend. `action: "build"`/"refresh" pages the library's top-level items (100
 * Params: action, library_type, library_id, limit, fulltext, fulltext_max_chars.
 */
export function index(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_index', input);
}

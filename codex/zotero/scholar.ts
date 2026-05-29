import { callMCPTool } from '../runtime.js';

/**
 * Scholarly context (references, citations, related) — Explore the scholarly graph around a paper via OpenAlex (open; Crossref fallback) and see what is — or is not yet — in your library. Provide a `doi` and an `action`: "lookup" (metadata + citation count), "references" (works this paper cites), "citations" (works that cite this paper, most-cited first), or "related" (similar works). With `include_in_library` (default true), each result is flagged `inLibrary` by matching DOIs against your library, so you can spot gaps ("cited works I haven't saved"). `limit` caps results (default 20). Read-only; calls external scholarly APIs.
 * Params: action, doi, limit, include_in_library.
 */
export function scholar(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_scholar', input);
}

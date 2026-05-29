import { callMCPTool } from '../runtime.js';

/**
 * Attachment full-text — Read, set, or track an attachment's extracted full text. `action`: "get" returns the indexed text content plus indexing stats for an attachment item (only attachment items have full text; returns found:false if none); "set" stores extracted text for an attachment (provide `content` and the indexing counts); "since" returns the map of attachment keys whose full text changed after a given library `version` (useful for incremental indexing). Only attachment items support full text. "set" writes via the cloud Web API.
 * Params: action, item_key, since, content, indexed_chars, total_chars, indexed_pages, total_pages, library_type, library_id.
 */
export function fulltext(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_fulltext', input);
}

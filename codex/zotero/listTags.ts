import { callMCPTool } from '../runtime.js';

/**
 * List Zotero tags (read-only) — List tags in a Zotero library with their usage count and whether each was auto-applied by Zotero. Optional `q` substring filter and `limit`. Read-only — available even when the connector runs in read-only mode (unlike zotero_manage_tags, which also writes). For taxonomy hygiene use zotero_tag_audit.
 * Params: q, limit, library_type, library_id.
 */
export function listTags(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_list_tags', input);
}

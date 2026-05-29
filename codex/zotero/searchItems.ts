import { callMCPTool } from '../runtime.js';

/**
 * Search Zotero items — Search or list items in a Zotero library or collection. Supports full-text/quick search via `q` (`qmode`: titleCreatorYear=default, everything=includes notes & attachment full text), boolean `itemType` filters (use `||` for OR, repeat or `&&` for AND, leading `-` to negate, e.g. "journalArticle || book", "-attachment"), boolean `tag` filters (same syntax; escape a literal leading hyphen as "\-"), `since` (version) for incremental queries, `sort`/`direction`, and `limit`/`start` paging. Set `response_format` to "detailed" to also return technical fields (version, tags, collections, DOI, url) ne
 * Params: q, qmode, itemType, tag, collectionKey, top, since, includeTrashed, sort, direction, limit, start, response_format, library_type, library_id.
 */
export function searchItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_search_items', input);
}

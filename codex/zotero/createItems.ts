import { callMCPTool } from '../runtime.js';

/**
 * Create or update Zotero items — Create new items or update existing ones in a single batch (the server auto-chunks into groups of 50). Each entry in `items` is a Zotero item-data object: include `itemType` plus its valid fields, `creators` (each `{creatorType, firstName, lastName}` or `{creatorType, name}`), `tags` (`[{tag}]`), and `collections` (array of collection keys). To UPDATE an existing item, also include its `key` and current `version`; to CREATE, omit both. Every item is validated against the Zotero schema before anything is sent — if any item is invalid, nothing is written and the problems are returned. Use zotero
 * Params: items, library_type, library_id.
 */
export function createItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_create_items', input);
}

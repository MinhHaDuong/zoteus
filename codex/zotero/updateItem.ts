import { callMCPTool } from '../runtime.js';

/**
 * Update a Zotero item — Partially update one item (HTTP PATCH — only the fields you supply change; omitted fields are preserved). Provide `item_key` and a `patch` object of the fields to change (e.g. {"title":"New","extra":"note"} or {"tags":[{"tag":"reviewed"}]}). Optimistic concurrency is handled for you: if you pass the item's `version` it is used; otherwise the current version is fetched first. If the item changed on the server in the meantime (412), the update is automatically re-fetched and retried once. Writes go to the cloud Web API.
 * Params: item_key, patch, version, library_type, library_id.
 */
export function updateItem(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_update_item', input);
}

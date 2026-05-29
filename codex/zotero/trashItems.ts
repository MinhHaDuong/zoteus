import { callMCPTool } from '../runtime.js';

/**
 * Trash or restore Zotero items — Move items to the trash (the safe, REVERSIBLE default) or restore them. This sets the `deleted` flag (1=trash, 0=restore) — it is NOT a permanent delete, so trashed items can be recovered here or in the Zotero app. Use this instead of zotero_delete_items unless you truly need irreversible removal. Provide `item_keys` and optional `action` (default "trash"). Writes go to the cloud Web API.
 * Params: item_keys, action, library_type, library_id.
 */
export function trashItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_trash_items', input);
}

import { callMCPTool } from '../runtime.js';

/**
 * Get a Zotero item — Fetch one item by its key, returning the full item record (itemType, all bibliographic fields, creators, tags, collections, relations, version). Optionally set `include_children` to also return the item's child notes and attachments. Use `include` to additionally request rendered output: "bib" (formatted bibliography entry), "citation" (inline citation), or "csljson" (CSL-JSON for downstream formatting); combine with `style` (a CSL style id, default chicago-note-bibliography) and `locale`. The returned `version` is required if you later update or delete this item.
 * Params: item_key, include_children, include, style, locale, library_type, library_id.
 */
export function getItem(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_get_item', input);
}

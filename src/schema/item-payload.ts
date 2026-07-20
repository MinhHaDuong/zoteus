import { z } from 'zod';

/**
 * Zod schemas for the structured (non-string) fields of a Zotero item-data
 * object, shared by zotero_update_item and zotero_create_items.
 *
 * Two jobs (issue #1):
 * 1. Advertise real shapes for creators/tags/collections/relations in the
 *    tool's JSON schema, instead of an opaque `additionalProperties: {}`
 *    object that leaves clients guessing.
 * 2. Repair the degraded encodings loosely-typed clients actually send for
 *    array values — a JSON-encoded string, a single un-wrapped object, a
 *    numeric-keyed object, or a wrapper object around the real array — before
 *    they reach the Zotero API, which rejects them with
 *    "<field> property must be an array".
 */

/** Wrapper keys some clients emit around an array value (e.g. {"item": [...]}). */
const WRAPPER_KEYS = new Set(['item', 'items', 'value', 'values', 'data', 'array', 'list', 'entries']);

function parseJsonish(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s.startsWith('[') && !s.startsWith('{')) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

/** Coerce degraded encodings of an array-of-objects value back into an array. */
function toArray(v: unknown): unknown {
  v = parseJsonish(v);
  if (v == null || Array.isArray(v) || typeof v !== 'object') return v;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec);
  const k0 = keys[0];
  if (keys.length === 1 && k0 !== undefined) {
    const only = rec[k0];
    if (Array.isArray(only) && (WRAPPER_KEYS.has(k0) || k0 === '0')) return only;
  }
  if (keys.length > 0 && keys.every((k, i) => k === String(i))) return keys.map((k) => rec[k]);
  return [v];
}

/** Like toArray, but a bare string becomes a one-element array (collection keys). */
function toStringArray(v: unknown): unknown {
  const r = toArray(v);
  return typeof r === 'string' ? [r] : r;
}

export const creatorsField = z
  .preprocess(toArray, z.array(z.record(z.any())))
  .describe('Array of creator objects: {creatorType, firstName, lastName} or {creatorType, name}.');

export const tagsField = z
  .preprocess(toArray, z.array(z.record(z.any())))
  .describe('Array of tag objects: [{"tag": "name"}].');

export const collectionsField = z
  .preprocess(toStringArray, z.array(z.string()))
  .describe('Array of 8-character collection keys.');

export const relationsField = z
  .preprocess(parseJsonish, z.record(z.any()))
  .describe('Object mapping a relation predicate to a URI or array of URIs.');

const structuredFields = {
  creators: creatorsField.optional(),
  tags: tagsField.optional(),
  collections: collectionsField.optional(),
  relations: relationsField.optional(),
};

/** One Zotero item-data object: structured fields typed and repaired, all other fields pass through. */
export const itemDataSchema = z.object(structuredFields).catchall(z.any());

/** A PATCH payload: same shape as item data, nothing required. */
export const itemPatchSchema = itemDataSchema;

/** An array of item-data objects; repairs a JSON-encoded string or single object at the top level too. */
export const itemsArraySchema = z.preprocess(toArray, z.array(itemDataSchema).min(1));

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

/** Item fields whose Zotero value is always an array of objects (or strings). */
const OBJECT_ARRAY_FIELDS = new Set(['creators', 'tags']);
/** Item field whose Zotero value is an array of plain strings (collection keys). */
const STRING_ARRAY_FIELDS = new Set(['collections']);
/** Item field whose Zotero value is a single object (relation predicate -> URI(s)). */
const OBJECT_FIELDS = new Set(['relations']);

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

/**
 * Suffixes some loosely-typed clients append to field names when re-emitting
 * quoted keys (observed in the wild: `creatorsQuote`, `collectionsQuote`).
 * `creatorsQuote` -> `creators` etc. A suffixed key is only renamed when the
 * plain base name is absent, so a real field is never clobbered; anything
 * unrecognized still reaches validation and produces an actionable error.
 */
const FIELD_NAME_SUFFIXES = ['Quote'];

/** Singular spellings of array fields that Zotero only accepts in the plural. */
const FIELD_NAME_ALIASES: Record<string, string> = {
  collection: 'collections',
  creator: 'creators',
  tag: 'tags',
};

function normalizeFieldNames(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    let key = k;
    for (const suf of FIELD_NAME_SUFFIXES) {
      if (key.endsWith(suf) && key.length > suf.length) {
        const base = key.slice(0, -suf.length);
        if (!(base in item) && !(base in out)) key = base;
      }
    }
    const alias = FIELD_NAME_ALIASES[key];
    if (alias && !(alias in item) && !(alias in out)) key = alias;
    out[key] = v;
  }
  return out;
}

/**
 * Repair a single item-data object that arrived in a "wedding-cake" encoding
 * ({field: {field: value}}) — the shape some loosely-typed clients emit when a
 * JSON-Schema only advertises free-form objects. The itemType key itself is
 * unwrapped first (this is what lets `"itemType": {"itemType": "report"}`
 * become `"itemType": "report"`), then every non-structural field that is a
 * one-key wrapper object is unwrapped the same way.
 *
 * Example:
 *   {"itemType": {"itemType": "report"},
 *    "title": {"title": "Dyna-2"},
 *    "creators": [{"creatorType": {"creatorType": "author"}, "name": {"name": "X"}}]}
 * →
 *   {"itemType": "report", "title": "Dyna-2",
 *    "creators": [{"creatorType": "author", "name": "X"}]}
 *
 * MT: it repairs what a corrected model still gets wrong, without silently
 * accepting arbitrary junk; a value that does not match the wrapper pattern
 * is left untouched and will surface in schema validation.
 */
/** Unwrap one-key wrapper values inside array elements, one level deep. */
function unwrapObjectArrayElements(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.map((el) => {
    if (el && typeof el === 'object' && !Array.isArray(el)) {
      const rec2 = el as Record<string, unknown>;
      for (const [k2, v2] of Object.entries(rec2)) {
        if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) {
          const rec3 = v2 as Record<string, unknown>;
          if (Object.keys(rec3).length === 1) {
            const only = rec3[Object.keys(rec3)[0]!];
            if (only !== null && typeof only !== 'object') rec2[k2] = only;
          }
        }
      }
      return rec2;
    }
    return el;
  });
}

export function repairItemData(raw: Record<string, unknown>): Record<string, unknown> {
  const item: Record<string, unknown> = normalizeFieldNames({ ...raw });

  // The itemType key is REQUIRED and must be a plain string. A wrapper object
  // (e.g. {"itemType": "report"}) or an empty object gets unwrapped/cleared so
  // validation can give an accurate, actionable error.
  const it = item.itemType;
  if (it && typeof it === 'object' && !Array.isArray(it)) {
    const inner = (it as Record<string, unknown>).itemType;
    if (typeof inner === 'string' && inner) {
      item.itemType = inner;
    } else {
      const keys = Object.keys(it as Record<string, unknown>);
      if (keys.length === 1) {
        // e.g. {"itemType": "report"} (self-named single key)
        const v = (it as Record<string, unknown>)[keys[0]!];
        item.itemType = typeof v === 'string' && v ? v : undefined;
      } else {
        item.itemType = undefined; // let validation name the actual value
      }
    }
  }

  for (const [k, v] of Object.entries(item)) {
    if (k === 'itemType') continue;

    if (STRING_ARRAY_FIELDS.has(k)) {
      // collections: accept a bare string key, {collections: "KEY"}, or an
      // array that may contain {"collections": "KEY"} wrapper elements.
      if (typeof v === 'string') {
        item[k] = [v];
      } else if (Array.isArray(v)) {
        item[k] = v.map((el) =>
          el && typeof el === 'object' && !Array.isArray(el)
            ? (() => {
                const rec = el as Record<string, unknown>;
                const keys = Object.keys(rec);
                if (keys.length === 1 && typeof rec[keys[0]!] === 'string') return rec[keys[0]!] as string;
                return el;
              })()
            : el,
        );
      } else if (v && typeof v === 'object') {
        // Object wrappers: {"collections": "KEY"} / {"collection": "KEY"} -> ["KEY"],
        // {"collections": ["KEY"]} -> ["KEY"]; anything else keeps the generic repair.
        const rec = v as Record<string, unknown>;
        const keys = Object.keys(rec);
        const only = keys.length === 1 ? rec[keys[0]!] : undefined;
        if (typeof only === 'string') item[k] = [only];
        else if (Array.isArray(only)) item[k] = only;
        else item[k] = toStringArray(rec);
      }
      continue;
    }

    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      if (OBJECT_ARRAY_FIELDS.has(k)) {
        // Degraded-shape repair for object-array fields: {item: [...]} -> [...],
        // {0: {...}} -> [{...}], {tag: "x"} -> [{tag: "x"}] — plus the self-named
        // wrapper observed in the wild: {"creators": [...]} -> [...]. Elements are
        // unwrapped afterwards, exactly like the plain-array branch below.
        const keys = Object.keys(rec);
        const only = keys.length === 1 ? rec[keys[0]!] : undefined;
        item[k] = unwrapObjectArrayElements(Array.isArray(only) ? only : toArray(rec));
        continue;
      }
      if (OBJECT_FIELDS.has(k)) continue; // relations is genuinely an object: leave it.
      // Other fields: unwrap {field: value} -> field: value, but keep
      // {field: {…}} and multi-key objects intact.
      if (Object.keys(rec).length === 1) {
        const only = rec[Object.keys(rec)[0]!];
        if (only !== null && typeof only !== 'object') item[k] = only;
      }
    } else if (Array.isArray(v)) {
      // unwrap creator/tag objects inside arrays, one level deep
      item[k] = unwrapObjectArrayElements(v);
    }
  }
  return item;
}

/** Apply repairItemData to every element of an items array. */
export function repairItems(raw: unknown): unknown[] {
  // Accept anything preprocess gives us; the schema downstream enforces the result.
  return repairItemsAsUnknown(raw);
}
function repairItemsAsUnknown(raw: unknown): unknown[] {
  const arr = toArray(raw);
  if (!Array.isArray(arr)) return Array.isArray(raw) ? raw : [raw];
  return arr.map((el) => (el && typeof el === 'object' && !Array.isArray(el) ? repairItemData(el as Record<string, unknown>) : el));
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
  /** Deliberately typed as a string so clients see `itemType: "journalArticle"` in the JSON Schema. */
  itemType: z.string().optional().describe('The Zotero item type as a plain string, e.g. "journalArticle", "book", "preprint", "report", "thesis".'),
  creators: creatorsField.optional(),
  tags: tagsField.optional(),
  collections: collectionsField.optional(),
  relations: relationsField.optional(),
};

/** One Zotero item-data object: structured fields typed and repaired, all other fields pass through. */
export const itemDataSchema = z.object(structuredFields).catchall(z.any());

const repairItemDataSafe: RepairFn = (raw: unknown) =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? repairItemData(raw as Record<string, unknown>) : raw;

/** A PATCH payload: same shape as item data, nothing required. Also repairs wedding-cake patch encodings. */
export const itemPatchSchema = z.preprocess(repairItemDataSafe, itemDataSchema);

type RepairFn = (arg: unknown) => unknown;
const repairItemsSafe: RepairFn = (raw: unknown) => repairItems(raw);

/** An array of item-data objects; repairs a JSON-encoded string or single object at the top level too, and unwraps wedding-cake item encodings. */
export const itemsArraySchema = z.preprocess(repairItemsSafe, z.array(itemDataSchema).min(1));

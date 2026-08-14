import type { ZoteroSchema } from './schema-service.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const SPECIAL = new Set(['note', 'attachment', 'annotation']);
const RESERVED = new Set([
  'itemType',
  'creators',
  'tags',
  'collections',
  'relations',
  'key',
  'version',
  'dateAdded',
  'dateModified',
  'parentItem',
  'deleted',
]);

/** A readable rendering of any value, so error messages show what a client actually sent. */
function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Validate an item-data object against the cached Zotero schema before a write. */
export function validateItem(schema: ZoteroSchema, item: any): ValidationResult {
  const errors: string[] = [];
  const itemType = item?.itemType;

  if (itemType === undefined || itemType === null || itemType === '') {
    return { valid: false, errors: ['Missing required "itemType": include a plain string like "journalArticle" or "book" (e.g. {"itemType": "journalArticle", "title": "…"}).'] };
  }
  if (typeof itemType !== 'string') {
    // Distinguish the two realistic mistakes so the model can self-correct:
    // a wrapper object {"itemType": "report"} vs an outright empty object.
    if (typeof itemType === 'object' && !Array.isArray(itemType)) {
      const keys = Object.keys(itemType as Record<string, unknown>);
      if (keys.length === 1) {
        return {
          valid: false,
          errors: [
            `Invalid itemType: expected a plain string like "journalArticle", got a wrapper object {${keys[0]}: ${show((itemType as Record<string, unknown>)[keys[0]!])}}. Pass "itemType": "journalArticle" directly (no nested object).`,
          ],
        };
      }
      if (keys.length === 0) {
        return {
          valid: false,
          errors: ['Invalid itemType: got an empty object {}. Pass a plain string like "itemType": "journalArticle".'],
        };
      }
    }
    return { valid: false, errors: [`Invalid itemType: expected a plain string like "journalArticle", got ${show(itemType)}.`] };
  }

  const def = schema.itemTypes.find((t) => t.itemType === itemType);
  if (!def) {
    return {
      valid: false,
      errors: [`Unknown itemType "${itemType}". Use zotero_schema to list valid types.`],
    };
  }

  // note/attachment/annotation bypass the normal field/creator model.
  if (SPECIAL.has(itemType)) return { valid: true, errors: [] };

  const validFields = new Set((def.fields ?? []).map((f) => f.field));
  for (const k of Object.keys(item)) {
    if (RESERVED.has(k)) continue;
    if (!validFields.has(k)) {
      errors.push(`Field "${k}" is not valid for itemType "${itemType}".`);
    }
  }

  const validCreatorTypes = new Set((def.creatorTypes ?? []).map((c) => c.creatorType));
  for (const c of item.creators ?? []) {
    if (c?.creatorType && !validCreatorTypes.has(c.creatorType)) {
      errors.push(`Creator type "${c.creatorType}" is not valid for itemType "${itemType}".`);
    }
  }

  return { valid: errors.length === 0, errors };
}

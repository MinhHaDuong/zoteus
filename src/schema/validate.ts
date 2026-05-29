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

/** Validate an item-data object against the cached Zotero schema before a write. */
export function validateItem(schema: ZoteroSchema, item: any): ValidationResult {
  const errors: string[] = [];
  const itemType = item?.itemType;
  if (!itemType) return { valid: false, errors: ['Missing required "itemType".'] };

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

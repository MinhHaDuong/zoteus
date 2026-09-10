import { z } from 'zod';
import type { ZodRawShape, ZodTypeAny } from 'zod';

/**
 * Closing the top-level arguments of every tool, at the one place they are all registered.
 *
 * Each tool hands `registerTool` a `ZodRawShape` and the SDK builds a plain `z.object` from
 * it, which STRIPS what it does not recognise. So `zotero_search_items {query:"kalman"}`
 * reached the handler as `{}` and answered "Found 1266 item(s); showing 3": the whole
 * library, reported as a success, for a call that had asked one specific question. The same
 * held for `{search:"kalman"}`, for `zotero_list_tags {filter:"core"}` (50 tags where the
 * right spelling returns 1) and for `zotero_tag_audit {collection_keys:[...]}` (a
 * full-library audit with the scope silently dropped). `query` for `q` is the single
 * likeliest mistake a language model makes against this API.
 *
 * The JSON Schema those tools advertise already said `additionalProperties: false`; only the
 * runtime had never enforced it. This makes the two agree, and no documented argument moves.
 *
 * Why `.strict()` with an error map, rather than the `z.preprocess` twin-matcher that
 * `zotero_annotate` and `zotero_tag_audit` use for their NESTED objects: measured against
 * this SDK (1.29.0), a `z.preprocess` at the TOP level is not an object schema, so the SDK
 * cannot find a shape in it and `tools/list` advertises `{"type":"object","properties":{}}`,
 * with every argument and the `additionalProperties: false` gone. `z.object(...).strict()` leaves
 * the advertised schema byte-for-byte identical, and an error map on the object reaches the
 * `unrecognized_keys` issue, which is where the twin can still be named. Nested objects are
 * under no such constraint, which is why the two fixes that came first could take the other
 * road.
 */

/**
 * `collectionKeys`, `Collection-Keys` and `collection_keys` all reduce to `collectionkeys`,
 * which is what lets a key whose only fault is its spelling be paired with the one it meant.
 */
const fold = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The words a name is built from, singular, so that `collections` and `collection_keys` are
 * seen to share one. camelCase counts as a word boundary, like `_` and `-` do.
 */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 2 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/**
 * Whether `key` is a misspelling of `field` rather than a different idea altogether. Two
 * rules, both of them things callers really type: a name that truncates or extends the field
 * (`query` for `q`, `item_key` for `item_keys`), and a name built out of a subset of the
 * field's words (`keys` for `collection_keys`).
 */
function isTwin(key: string, field: string): boolean {
  const a = fold(key);
  const b = fold(field);
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const kw = new Set(words(key));
  const fw = new Set(words(field));
  const [fewer, more] = kw.size <= fw.size ? [kw, fw] : [fw, kw];
  return fewer.size > 0 && [...fewer].every((w) => more.has(w));
}

/** A member of a nested object argument, and the dotted path the caller should have used. */
interface NestedMember {
  member: string;
  parent: string;
  path: string;
}

/**
 * The object shape `schema` carries once its wrappers are peeled off, and whether an array
 * was one of them (so a path can be shown as `annotations[].text`).
 *
 * `z.preprocess` is peeled too, because that is how `zotero_annotate` and `zotero_tag_audit`
 * close their nested objects, and their members are exactly the ones a caller most often
 * hoists to the top level by mistake: `collection_keys` belongs to `scope`, `text` to an
 * `annotations` entry, `title` to `patch`. Anything that is not an object underneath (a
 * `z.record`, a union, an array of strings) simply contributes nothing.
 */
function innerShape(
  schema: ZodTypeAny,
  viaArray = false,
  depth = 0,
): { shape: ZodRawShape; viaArray: boolean } | undefined {
  if (depth > 8) return undefined;
  if (schema instanceof z.ZodObject) return { shape: schema.shape as ZodRawShape, viaArray };
  const def = schema._def as { innerType?: ZodTypeAny; schema?: ZodTypeAny; type?: ZodTypeAny };
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return def.innerType ? innerShape(def.innerType, viaArray, depth + 1) : undefined;
  }
  if (schema instanceof z.ZodEffects) {
    return def.schema ? innerShape(def.schema, viaArray, depth + 1) : undefined;
  }
  if (schema instanceof z.ZodArray) {
    return def.type ? innerShape(def.type, true, depth + 1) : undefined;
  }
  return undefined;
}

/** Every member of every object-valued argument, one level down, with its dotted path. */
export function nestedMembers(shape: ZodRawShape): NestedMember[] {
  const out: NestedMember[] = [];
  for (const [parent, schema] of Object.entries(shape)) {
    const inner = innerShape(schema as ZodTypeAny);
    if (!inner) continue;
    const prefix = inner.viaArray ? `${parent}[]` : parent;
    for (const member of Object.keys(inner.shape)) {
      out.push({ member, parent, path: `${prefix}.${member}` });
    }
  }
  return out;
}

/**
 * MCP keeps its own bookkeeping under `_meta`, on the request's `params`, never inside a
 * tool's `arguments`. One arriving here is a client bug and not a misspelled argument, so it
 * is answered with where it belongs instead of with a list of Zotero fields.
 */
const isReservedKey = (key: string): boolean => key.startsWith('_');

/** The one nested member `key` could have meant, or undefined when it is none or several. */
function hoistedFrom(
  key: string,
  nested: NestedMember[],
  match: (a: string, b: string) => boolean,
): NestedMember | undefined {
  const candidates = nested.filter((n) => match(key, n.member));
  const first = candidates[0];
  return first && new Set(candidates.map((n) => n.path)).size === 1 ? first : undefined;
}

/**
 * Names the argument that was not understood and, where its only fault was how it was spelled
 * or where it was put, the one it was probably meant to be. An argument that resembles two of
 * them at once resolves to neither: guessing between them would be worse than listing what is
 * on offer.
 *
 * A name that IS a nested field, exactly, is answered first, because that is the stronger
 * evidence: `zotero_create_items {itemType:"book"}` means `items[].itemType`, and the
 * spelling rule would otherwise pair it with `items` and claim the tool spells it that way.
 */
function unknownArgumentProblem(key: string, fields: string[], nested: NestedMember[]): string {
  if (isReservedKey(key)) {
    return `unknown argument \`${key}\`: protocol metadata belongs on the request's \`params._meta\`, not in a tool's arguments.`;
  }
  const exact = hoistedFrom(key, nested, (a, b) => a === b);
  if (exact) {
    return `unknown argument \`${key}\`: this tool takes it inside \`${exact.parent}\`, as \`${exact.path}\`.`;
  }
  const twins = fields.filter((f) => isTwin(key, f));
  if (twins.length === 1) return `unknown argument \`${key}\`: this tool spells it \`${twins[0]}\`.`;
  if (twins.length === 0) {
    // Not a top-level argument under any spelling, so the next likeliest mistake is a nested
    // one that was hoisted and misspelled on the way: `collections` for `scope.collection_keys`.
    const hoisted = hoistedFrom(key, nested, isTwin);
    if (hoisted) {
      return `unknown argument \`${key}\`: this tool takes it inside \`${hoisted.parent}\`, as \`${hoisted.path}\`.`;
    }
  }
  return `unknown argument \`${key}\`. The arguments are: ${fields.join(', ')}.`;
}

/** The whole refusal: one sentence per unknown argument, then what it cost, once. */
export function explainUnknownArguments(
  keys: string[],
  fields: string[],
  nested: NestedMember[],
): string {
  const named = keys.map((k) => unknownArgumentProblem(k, fields, nested)).join(' ');
  return `${named} Nothing ran, because the value you sent would have been dropped and the call would have answered a different question.`;
}

/**
 * A tool's arguments as a schema that refuses a key it does not know, instead of dropping it.
 *
 * A tool that declares NO arguments is left exactly as it is. Its advertised schema is the
 * one in this server that does not say `additionalProperties: false` (an empty raw shape
 * reaches the SDK through a different Zod dialect, which emits no such line), and it has one
 * behaviour and one answer, so a key it drops cannot have changed what it replied. Closing it
 * would refuse `zotero_groups {library_type:"group"}`, which answers correctly today, and
 * would tighten a schema this server has never advertised as closed.
 */
export function closedArgumentSchema(shape: ZodRawShape): ZodRawShape | ZodTypeAny {
  const fields = Object.keys(shape);
  if (fields.length === 0) return shape;
  const nested = nestedMembers(shape);
  const errorMap: z.ZodErrorMap = (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return { message: explainUnknownArguments(issue.keys, fields, nested) };
    }
    return { message: ctx.defaultError };
  };
  return z.object(shape, { errorMap }).strict();
}

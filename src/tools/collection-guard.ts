import type { ToolContext, ToolHandlerResult } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';

/**
 * Refuse a read scoped to a collection key the library does not have, or `undefined` when
 * there is nothing to refuse.
 *
 * The desktop local API does not refuse an unknown collection on the route the tools use:
 * `/collections/<unknown>/items` answers 200 with the WHOLE library (measured: 723 items
 * for a key that does not exist, 14 for one that does), so a mistyped or stale key came
 * back as a plausible scoped answer that was really the entire library, and a scoped
 * search was byte-for-byte identical to an unscoped one. The collection itself does 404,
 * which is the one place the desktop admits the key is unknown, and that is the question
 * asked here.
 *
 * Only asked when the caller actually named a collection AND the desktop app is serving
 * this library, so the common unscoped read costs nothing extra: api.zotero.org 404s
 * `/collections/<unknown>/items` on its own (measured against a public group), so a cloud
 * read is already refused without a second request.
 */
export async function refuseUnknownCollection(
  ctx: ToolContext,
  collectionKey: string | undefined,
  library: LibraryRef,
  /** Past-tense verb for what did not happen: "searched", "exported". */
  attempted: string,
): Promise<ToolHandlerResult | undefined> {
  if (!collectionKey || !ctx.local || !ctx.router.servesLocally(library)) return undefined;
  let exists: boolean;
  try {
    exists = await ctx.local.collectionExists(collectionKey, library);
  } catch {
    // The app going away between this question and the read is not evidence that the
    // collection is missing, so say nothing and let the read report its own failure.
    return undefined;
  }
  if (exists) return undefined;
  const where = library.type === 'group' ? `group ${library.id}` : 'your personal library';
  return {
    content: [
      {
        type: 'text',
        text:
          `No collection ${collectionKey} in ${where}, so nothing was ${attempted}. ` +
          'Call zotero_list_collections and use the `key` it returns. ' +
          'Refused rather than answered because the Zotero desktop API replies to an unknown ' +
          'collection key with the whole library, which would have read as a successful ' +
          'scoped result.',
      },
    ],
    isError: true,
  };
}

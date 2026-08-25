/**
 * Index build limits, kept in their own module so `config.ts` can read the default without
 * importing `build.ts` and, with it, the search feature's runtime dependencies (persistence,
 * the full-text source, and whatever those grow into). Config stays a leaf that any module
 * can import.
 */

/**
 * Default cap on items per build. Not a hard ceiling: `ZOTEUS_INDEX_MAX_ITEMS` raises it
 * for libraries that outgrow it. The default stays where it was so an existing install
 * keeps its build time and index size unchanged.
 */
export const DEFAULT_INDEX_MAX_ITEMS = 5000;

/**
 * Default passages per embedding call: one transformers pipeline call locally, one HTTP
 * request through an API provider. `ZOTEUS_EMBED_BATCH_SIZE` overrides it, which matters
 * for API providers: a request carrying more tokens than the provider accepts is rejected
 * whole (OpenAI answers 400 above 300K tokens per request), and full-text passages reach
 * that ceiling far sooner than metadata ones.
 */
export const DEFAULT_EMBED_BATCH_SIZE = 32;

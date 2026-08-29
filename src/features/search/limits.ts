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

/**
 * How many candidates the binary-code stage of a semantic query hands the exact rescore,
 * per vector hit the fusion asks for. The pool decides the accuracy of the whole two-stage
 * search: measured on real embeddings against the exact ranking, recall@30 was 0.884 at a
 * 4x pool, 0.953 at 8x and 0.986 at 16x, and rises with the width of the vectors (#30).
 * 16 buys the accurate end of that curve while still reading a few hundred vectors instead
 * of every one. `ZOTEUS_INDEX_ANN_OVERSAMPLE` overrides it.
 */
export const DEFAULT_ANN_OVERSAMPLE = 16;

/**
 * Floor on that candidate pool, so a small page still rescores a meaningful neighbourhood:
 * `limit:1` would otherwise ask the codes to order 48 rows on their own, which is exactly
 * what they are bad at. 500 rows cost about a millisecond to rescore.
 * `ZOTEUS_INDEX_ANN_MIN_CANDIDATES` overrides it.
 */
export const DEFAULT_ANN_MIN_CANDIDATES = 500;

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

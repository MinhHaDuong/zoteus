/**
 * Index build limits, kept in their own module so `config.ts` can read the default
 * without importing `build.ts` — which pulls in the registry and would close an
 * import cycle back onto config.
 */

/**
 * Default cap on items per build. Not a hard ceiling: `ZOTEUS_INDEX_MAX_ITEMS` raises it
 * for libraries that outgrow it. The default stays where it was so an existing install
 * keeps its build time and index size unchanged.
 */
export const DEFAULT_INDEX_MAX_ITEMS = 5000;

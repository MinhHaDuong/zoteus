import { tokenize } from './tokenize.js';

/**
 * Turn a raw user query into an FTS5 `MATCH` expression, or null when nothing is left to
 * ask for.
 *
 * This is a safety boundary, not a convenience. `MATCH` takes a query *language*: `"`,
 * `*`, `NEAR`, `AND`, `OR`, `-`, `(`, `)`, `:` and `^` are syntax there, so a bare
 * apostrophe or a stray parenthesis in a user's question is a SQLite parse error that
 * surfaces as a failed tool call. BM25Index never had this exposure — it tokenises the
 * query itself and can therefore be handed anything.
 *
 * Two decisions are worth naming:
 *
 * - Tokenising with the SAME `tokenize()` the JS index uses (lowercase, split on
 *   non-alphanumerics, drop stopwords and 1-char tokens) means the surviving tokens are
 *   `[a-z0-9]+` by construction. There is consequently nothing left to escape: quoting is
 *   belt-and-braces, and the two backends see the same query terms.
 * - Joining with ` OR ` settles the semantics. FTS5 defaults to an implicit AND between
 *   terms; zoteus's BM25 sums per-term contributions, i.e. it ORs. Matching today's
 *   behaviour is the point of the exercise, so OR wins.
 */
export function toMatchQuery(q: string): string | null {
  // De-duplicated for the same reason BM25Index.search de-duplicates: a term repeated in
  // the query is one constraint, not two.
  const terms = [...new Set(tokenize(q))];
  if (terms.length === 0) return null;
  // A double-quoted FTS5 string is a literal, never an operator: `"or"` is the word.
  return terms.map((t) => `"${t}"`).join(' OR ');
}

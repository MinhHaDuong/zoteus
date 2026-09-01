/**
 * Which terms a query is actually answered on, and what to do when that set collapses.
 *
 * Search drops some of a query's terms before it runs — the words that appear nearly
 * everywhere, whose posting lists are expensive to walk and whose presence discriminates
 * between almost nothing. That is a good trade on an ordinary query and a silent failure
 * on a query made mostly of such words, because what is left is not a shorter version of
 * the question: it is a different question.
 *
 * `to be or not to be` is the whole defect in one line. Every word of it is on the
 * shipped stopword list except `not`, so the search that runs is a single-term OR on
 * `not` — a word that appears in a quarter of an academic library and means nothing there.
 * The user gets a confidently-ranked page of results that has no relation to what they
 * typed. Not an empty result, which would at least be honest; a wrong one.
 *
 * So the rule is not "drop the common words". It is "drop the common words **unless that
 * changes the question**", and there are two ways it can.
 *
 * It can leave too little of the question standing. `to be or not to be` keeps one word of
 * six, and one word out of six is not a shorter question, it is a different one — so the
 * raw token set is what runs.
 *
 * It can leave none of it standing, and that case is not the same and must not be treated
 * the same. A query of nothing but common words has no answer to give, and today it says
 * so instantly and for free. Running the raw set there would replace a free honest miss
 * with a slow arbitrary hit: measured on a real index, the bare query `the` goes from 0 ms
 * and no results to 750 ms and ten unrelated documents. Worse, the tokenizer folds
 * diacritics, so `the` is also where the French word for tea lands — a user searching
 * `thé` would get ten English documents about something else, slowly. Nothing survived
 * means nothing is returned, exactly as before.
 *
 * What is left, then, is the case in between: some of the query survived, but less of it
 * than was thrown away. That is the one the fallback is for, and confining it there is
 * what keeps `the brain` — one common word, one rare one — on the fast path where it
 * belongs, instead of walking a posting list for a term it never needed. Measured, that
 * one query is 3,3 ms pruned against 716,5 ms unpruned, and the pruned answer is the
 * better of the two.
 */

/** Whether a term is common enough in this index to be worth dropping from a query. */
export type Prunable = (term: string) => boolean;

/**
 * How many terms have to survive before the pruned query is answered on its own.
 *
 * Two, not one. A single survivor is a near-useless query when it survived by accident:
 * `not` is simply absent from the list, so `to be or not to be` reaches MATCH as a
 * one-term OR on a word that carries no meaning, and an empty-set guard never fires
 * because the set was never empty.
 */
export const MIN_MATCH_TERMS = 2;

/**
 * The snippet side wants one.
 *
 * Deliberately not the same number. The MATCH floor is about recall, where a single
 * OR-ed term answers badly; a snippet only needs somewhere to centre on, and one term is
 * a perfectly good anchor. Where nothing at all survives, the raw set keeps the snippet
 * where it is today rather than at character 0.
 */
export const MIN_SNIPPET_TERMS = 1;

/** The terms to search on. See the header: three outcomes, and the middle one is the fix. */
export function pruneTerms(terms: string[], prunable: Prunable, min: number): string[] {
  const kept = terms.filter((t) => !prunable(t));
  if (kept.length >= min) return kept;
  // Nothing survived. The query has no answer to give and has always said so for free.
  if (kept.length === 0) return kept;
  // Something survived, but less of the query than was thrown away. Run what was typed.
  return terms.length - kept.length > kept.length ? terms : kept;
}

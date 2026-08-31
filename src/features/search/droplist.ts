/**
 * Query-side pruning of the terms THIS library cannot discriminate on.
 *
 * **What it replaces.** `tokenize()` used to carry 29 English function words and drop them
 * from every query, on both backends. That list is wrong in three separate ways, and only
 * the first is about English. It is a *language* rule applied to a token space that holds
 * every language at once: German `die` and English `die` are the same string, so no
 * per-language list can drop one and keep the other, and the index cannot see which was
 * meant. It is a *guess* about frequency rather than a measurement of it — `energy` sits
 * at 26% document frequency in one real library, higher than several words on the list. And
 * it is *silent about its own cost*: dropping a term is worth doing because the posting
 * list is not walked, which is a property of this corpus and not of the word.
 *
 * So the question the list was answering badly — "what does this string cost to retrieve
 * on?" — is asked of the corpus instead, and has exactly one answer per index.
 *
 * **Why a hard cutoff, given that BM25 already down-weights common terms.** It does, and
 * continuously, which a step function can only approximate badly. The justification is
 * never ranking quality: it is latency. A term dropped is a posting list not walked. Judge
 * the threshold on cost alone and keep it high — measured on a 477 512-passage library,
 * dropping at 20% starts eating content terms (`energy`) while buying nothing the 30%
 * working point had not already bought.
 *
 * **Why the fallback triggers on degeneracy and not on emptiness.** `to be or not to be`
 * keeps exactly one term at a 30% cutoff — `not`, at 27% — so the set is never empty, an
 * empty-set fallback never fires, and a one-term OR query reproduces the very defect the
 * pruning was meant to fix: measured over a real library, a one-term answer to that query
 * shares 5 items of 35 with the answer the whole phrase gives. Fewer than two surviving
 * terms is the condition that catches it.
 */

/**
 * A term is high-df, and prunable, once it appears in this fraction of the passages.
 *
 * Measured over a real 477 512-passage library, sweeping the threshold: at 50% only nine
 * terms drop and p95 stays 1,6x over the latency allowance; at 20% the list reaches
 * `energy`, a content term in that library. The working window is roughly 25–35% and this
 * is the middle of it.
 */
export const HIGH_DF_RATIO = 0.3;

/**
 * How far the passage count may move before the droplist is derived again.
 *
 * A handful of new items cannot move a 30% threshold, and the derivation costs a full scan
 * of the term vocabulary — seconds on a large index. Paying that on every small delta is
 * the one way this becomes visible to a user, so the cost is amortised against the drift
 * that could actually change the answer.
 */
export const REDERIVE_DRIFT = 0.1;

/** Fewer surviving terms than this and the query is sent unpruned. See the header. */
export const MIN_MATCH_TERMS = 2;

/**
 * The snippet side wants one.
 *
 * Not the same number as MIN_MATCH_TERMS, and deliberately: the MATCH rule is about
 * recall, where a single OR-ed term is a near-useless query, while a snippet only needs
 * somewhere to centre on, and one content term is a perfectly good anchor. Where no term
 * survives, the raw set is what keeps the snippet where it is today rather than at
 * character 0.
 */
export const MIN_SNIPPET_TERMS = 1;

/** Whether a term appears in enough of this index's passages to be worth dropping. */
export type HighDf = (term: string) => boolean;

/**
 * The document frequency at which a term becomes prunable, in passages.
 *
 * Rounded up, so a corpus of three passages puts the bar at one and prunes everything —
 * which then degenerates and sends the raw set, i.e. the rule is inert on a corpus too
 * small to have document-frequency statistics. That is the right answer there, and it
 * falls out rather than being special-cased.
 */
export function highDfMinimum(passages: number): number {
  return Math.ceil(passages * HIGH_DF_RATIO);
}

/**
 * The terms to actually search on: the high-df ones removed, unless removing them leaves
 * too few to answer with, in which case the caller's own set is returned untouched.
 */
export function pruneTerms(terms: string[], highDf: HighDf | undefined, min: number): string[] {
  if (!highDf) return terms;
  const kept = terms.filter((t) => !highDf(t));
  return kept.length >= min ? kept : terms;
}

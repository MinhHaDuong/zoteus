/**
 * Which terms a query is actually answered on, and what to do when that set collapses.
 *
 * Search drops some of a query's terms before it runs — the words that appear nearly
 * everywhere, whose posting lists are expensive to walk and whose presence discriminates
 * between almost nothing. Two separate decisions live here: **which** terms those are,
 * and **when** dropping them has gone too far.
 *
 * **Which.** They are read off the library rather than shipped with the code. The
 * alternative, a list of English function words, is wrong in three ways and only the first
 * is about English. It is a *language* rule applied to a token space that holds every
 * language at once: German `die` and English `die` are the same string in the index, so no
 * such list can drop one and keep the other, and nothing at the point of consultation
 * knows which was meant. It is a *guess* about frequency rather than a measurement of it —
 * measured on a real library, `energy` sits at 26,2% document frequency, above several
 * words the shipped list carries, and dropping it would be a catastrophic answer to a
 * query about energy. And it is *silent about its own cost*: a term is worth dropping
 * because a posting list is not walked, which is a property of this corpus and not of the
 * word. So the question the list answered badly — what does this string cost to retrieve
 * on here? — is asked of the corpus instead, where it has exactly one answer.
 *
 * So the rule is not "drop the common words". It is "drop the common words **unless that
 * changes the question**", and there are two ways it can.
 *
 * It can leave too little of the question standing. `to be or not to be` keeps one word of
 * six, and one word out of six is not a shorter question, it is a different one — so the
 * raw token set is what runs.
 *
 * It can leave none of it standing, and what to do then depends on where the list came
 * from — which is why the caller says, rather than this deciding.
 *
 * A curated list holds function words and nothing else, so a query it empties was made of
 * function words and has no answer to give. Saying so instantly is what search has always
 * done, and running the raw set instead would replace a free honest miss with a slow
 * arbitrary hit: measured, the bare query `the` goes from 0 ms and no results to 750 ms and
 * ten unrelated documents.
 *
 * A list measured from a corpus is not like that. It contains whatever that library is
 * saturated with, and that can be a content word: derived over the English passages of a
 * real library, `economics` reaches 35%. A query of nothing but such words is a real
 * question about the library's own subject, and answering it with silence is a worse
 * failure than answering it slowly — silence looks like an empty library. So there the raw
 * set runs.
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
 * What to answer when pruning leaves nothing at all — see the header.
 *
 * `nothing` where the caller's list is curated and holds only words no query means, and
 * `raw` where it is measured from a corpus and may hold the library's own subject matter.
 * Named rather than boolean because both answers are defensible and the call site is the
 * only place that knows which applies.
 */
export type WhenNothingSurvives = 'nothing' | 'raw';

/**
 * A term is common enough to prune once it appears in this fraction of the passages.
 *
 * Measured over a real 477,512-passage library by sweeping the threshold: at 50% only nine
 * terms drop and the latency barely moves; at 20% the list reaches `energy`, a content
 * term in that library. The working window is roughly 25-35% and this is the middle of it.
 *
 * Judge it on cost alone and keep it high. BM25 already down-weights common terms
 * continuously and does it better than any step function, so the justification for a hard
 * cutoff is never ranking quality — it is the posting list not walked.
 *
 * **Where this is known to be wrong.** The cutoff assumes a library broad enough that no
 * subject word saturates it. Derived over the English-language passages of that same
 * library alone, `economics` reaches 35.1% — a term a specialist searches on, pruned for
 * being what the library is about. The narrower the library, the closer this gets, and
 * nothing here detects it.
 */
export const HIGH_DF_RATIO = 0.3;

/**
 * Passages a corpus needs before a document frequency says anything about it.
 *
 * Below this the rule declines to prune at all, and that is a correctness guard rather
 * than a nicety. On five passages the 30% bar rounds to two, so an ordinary content word
 * appearing in two of them is "common" and is dropped from every query that uses it —
 * and once every term of a query is dropped, the search returns nothing. A small library
 * would go silent, which is a far worse failure than the slow query pruning exists to
 * avoid.
 *
 * A hundred is not a statistical guarantee, and no threshold here would be. It is the
 * point below which the proportion is plainly meaningless, chosen to be obviously safe
 * rather than tight: a real library reaches it within a handful of documents, and the
 * cost of being wrong on the low side is silence.
 */
export const MIN_DERIVATION_PASSAGES = 100;

/**
 * How far the passage count may move before the list is derived again.
 *
 * A handful of new items cannot move the threshold, and the derivation costs a full scan
 * of the term vocabulary — seconds on a large index. Paying that on every small delta is
 * the one way this becomes visible to a user, so the cost is amortised against the drift
 * that could change the answer. Drift in COUNT only: a library that replaces its subject
 * without changing size does not trigger a rescan.
 */
export const REDERIVE_DRIFT = 0.1;

/**
 * How many terms have to survive before the pruned query is answered on its own.
 *
 * Two, not one. A single survivor is a near-useless query when it survived by accident:
 * `not` sits at 27.3% on that library, just under the cutoff, so `to be or not to be`
 * reaches MATCH as a one-term OR on a word that carries no meaning — and an empty-set
 * guard never fires, because the set was never empty.
 */
export const MIN_MATCH_TERMS = 2;

/**
 * The snippet side wants one.
 *
 * Deliberately not the same number. The MATCH floor is about recall, where a single OR-ed
 * term answers badly; a snippet only needs somewhere to centre on, and one term is a
 * perfectly good anchor. Where nothing survives, nothing is returned and the snippet falls
 * back to the passage opening, which is where it has always been for such a query.
 */
export const MIN_SNIPPET_TERMS = 1;

/**
 * The document frequency at which a term becomes prunable, in passages.
 *
 * Rounded up, so a corpus of three passages puts the bar at one and every term clears it.
 * That does NOT fall out harmlessly, and an earlier version of this comment claimed it
 * did: a list naming the whole vocabulary prunes every query to nothing, and nothing is
 * then what the search returns. The derivation guards against it by declining to store a
 * list that covers the entire vocabulary — see `refreshDroplist`.
 */
export function highDfMinimum(passages: number): number {
  return Math.ceil(passages * HIGH_DF_RATIO);
}

/**
 * The terms to search on. See the header: three outcomes, and the middle one is the fix.
 *
 * `prunable` is undefined where an index has nothing to prune by — one written before this
 * existed, or one whose derivation failed — and then this is the identity. An index that
 * has not been told which terms are common must not guess.
 */
export function pruneTerms(
  terms: string[],
  prunable: Prunable | undefined,
  min: number,
  whenNothingSurvives: WhenNothingSurvives,
): string[] {
  if (!prunable) return terms;
  const kept = terms.filter((t) => !prunable(t));
  if (kept.length >= min) return kept;
  // Nothing survived. Which answer is right depends on the list; see the header.
  if (kept.length === 0) return whenNothingSurvives === 'raw' ? terms : kept;
  // Something survived, but less of the query than was thrown away. Run what was typed.
  return terms.length - kept.length > kept.length ? terms : kept;
}

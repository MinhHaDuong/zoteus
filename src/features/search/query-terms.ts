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
 * changes the question**", and the line is drawn at whether anything survives.
 *
 * While a term survives, the survivors are the query. `the brain` keeps one word of two,
 * and that word is the question: measured, it is 3,3 ms pruned against 716,5 ms unpruned,
 * and the pruned answer is the better of the two. An earlier rule fell back whenever the
 * prune dropped more than it kept, which sounds careful and is not — it put a document
 * saying `in the` sixty times ahead of the one about brains. If a term got through, the
 * corpus said it discriminates, and second-guessing that measurement re-imports the
 * guesswork the measurement replaced.
 *
 * When nothing survives, there is no question left to run, and what to do then depends on
 * where the list came from — which is why the caller says, rather than this deciding.
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
 * set runs. (An accented word no longer folds onto a common one — `thé`, French for tea,
 * used to land on `the` and is its own term now — so these paths are reached by genuinely
 * common words, which is what they are for.)
 */

/** Whether a term is common enough in this index to be worth dropping from a query. */
export type TermPredicate = (term: string) => boolean;

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
/**
 * Distinct terms a query needs before it is worth running unpruned when every one of them
 * is common — the `phrase` answer below.
 *
 * Three, and the number is doing less work than it looks: it separates "one or two common
 * words", which search has always answered with nothing, from "a phrase", which the user
 * plainly meant. It applies only when the prune left nothing at all, so no choice of it can
 * demote a content word.
 */
export const MIN_PHRASE_TERMS = 3;

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
 * What to answer when pruning leaves nothing at all.
 *
 * `phrase` is the answer a curated list earns: it holds function words and nothing else, so
 * a query it empties was made of function words. One or two of them are not a question and
 * are answered with nothing, instantly; three or more are a phrase the user typed, and that
 * is worth running.
 *
 * `raw` is the answer a measured list requires, and the difference is the whole reason this
 * is a parameter. A list read off a corpus holds whatever that library is saturated with,
 * and that can be its own subject: derived over the English passages of a real library,
 * `economics` reaches 35%. `economics`, typed alone into a library about economics, is a
 * real question, and answering it with silence because the word is common would be a worse
 * failure than answering it slowly. So there, whatever is left of the query runs.
 *
 * No production call site currently passes `phrase`: both backends measure their lists, so
 * both pass `raw`. The mode is kept because it is the correct answer for any future caller
 * holding a curated list, and only the call site can know which kind of list it holds.
 */
export type WhenNothingSurvives = 'phrase' | 'raw';

/**
 * The terms to search on. See the header: the prune is never undone while a term survives,
 * and what happens when none does is the caller's to say.
 *
 * `prunable` is undefined where an index has nothing to prune by — one written before this
 * existed, or one whose derivation failed — and then this is the identity. An index that has
 * not been told which terms are common must not guess.
 */
export function pruneTerms(
  terms: string[],
  prunable: TermPredicate | undefined,
  whenNothingSurvives: WhenNothingSurvives = 'phrase',
): string[] {
  if (!prunable) return terms;
  const kept = terms.filter((t) => !prunable(t));
  // Something survived. It is the query — never second-guess it.
  if (kept.length) return kept;
  if (whenNothingSurvives === 'raw') return terms;
  return terms.length >= MIN_PHRASE_TERMS ? terms : kept;
}

/**
 * Most accented spellings one expanded query term may carry, highest document frequency
 * first (see the SQLite backend's expandTerm and the memory backend's search). Bounds
 * the expanded query against a corpus seeded with crafted spellings; comfortably above
 * the widest real group measured (15, the Vietnamese syllables under `to`).
 */
export const MAX_ACCENT_VARIANTS = 24;

/**
 * Which terms a query is actually answered on, and what to do when that leaves nothing.
 *
 * Search drops the words that appear nearly everywhere: their posting lists are long and
 * their presence separates almost nothing. That is a good trade on an ordinary query and a
 * silent failure on a query made entirely of such words, because what is left is not a
 * shorter version of the question — there is no question left.
 *
 * `to be or not to be` is the defect in one line. Every word of it was on the list except
 * `not`, so one term limped through and the search that ran was a single-term OR on a word
 * that appears in a quarter of an academic library. The user got a confidently-ranked page
 * of results unrelated to what they typed. Not an empty result, which would at least be
 * honest; a wrong one.
 *
 * **The rule never fires while anything survives, and that restraint is the whole design.**
 * A version of this fell back whenever the prune left fewer terms than it dropped, which
 * sounds careful and is not: `in the brain` keeps one content word, drops two common ones,
 * and would have run unpruned — putting a document that says `in the ` sixty times ahead of
 * the one about brains. That is this defect arriving from the other direction, on a far
 * more ordinary query. Nothing distinguishes an accidental survivor like `not` from a real
 * one like `brain` except how common each is, and a fixed list cannot know that. So a fixed
 * list must not guess: if a term survived, it is the query, and it is what runs.
 *
 * That leaves only the case where nothing survived, where there is no content word to
 * demote and the choice is safe to make. One or two common words are not a question —
 * `the`, `of the` — and search has always answered those with nothing, instantly. Three or
 * more are a phrase, and a phrase the user typed is worth running even though every word of
 * it is common. Measured, the bare query `the` costs 0 ms and returns nothing where running
 * it costs 750 ms and returns ten unrelated documents. (An accented word no longer folds
 * onto a common one — `thé`, French for tea, used to land on `the` and is its own term
 * now — so this path is reached by genuinely common words, which is what it was for.)
 */

/** Whether a term is common enough in this index to be worth dropping from a query. */
export type TermPredicate = (term: string) => boolean;

/**
 * Distinct terms a query needs before it is worth running unpruned when every one of them
 * is common.
 *
 * Three, and the number is doing less work than it looks. It is not tuned to any query: it
 * separates "one or two common words", which search has always answered with nothing, from
 * "a phrase", which the user plainly meant. The rule it guards applies only when the prune
 * left nothing at all, so no choice of this number can demote a content word.
 */
export const MIN_PHRASE_TERMS = 3;

/**
 * The terms to search on: the common ones removed, and the caller's own set back only when
 * removing them left nothing and there was a phrase to recover. See the header.
 */
export function pruneTerms(terms: string[], prunable: TermPredicate): string[] {
  const kept = terms.filter((t) => !prunable(t));
  // Something survived. It is the query — never second-guess it.
  if (kept.length) return kept;
  // Nothing survived. A phrase runs as typed; one or two common words answer as they always
  // have, with nothing, for free.
  return terms.length >= MIN_PHRASE_TERMS ? terms : kept;
}

/**
 * Most accented spellings one expanded query term may carry, highest document frequency
 * first (see the SQLite backend's expandTerm and the memory backend's search). Bounds
 * the expanded query against a corpus seeded with crafted spellings; comfortably above
 * the widest real group measured (15, the Vietnamese syllables under `to`).
 */
export const MAX_ACCENT_VARIANTS = 24;

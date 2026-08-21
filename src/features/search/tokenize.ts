const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'by', 'as', 'at', 'that', 'this', 'it', 'from', 'we', 'our', 'their', 'its', 'these', 'those',
]);

/**
 * Combining marks sitting on a **Latin** base, which is the only place
 * `unicode61 remove_diacritics 2` removes them: measured, Greek tonos and Cyrillic breve
 * survive there, so they survive here. See normalizeForSearch.
 *
 * U+0300–U+036F rather than `\p{M}`, which is the block NFD produces for Latin (Vietnamese
 * included: the tone marks and the dot below are all in it) and the range Zotero's own
 * normalizer strips. Not a shortcut — measured at 4,8 µs against 31,1 µs per 740-character
 * passage for the property class, and the codepoint-by-codepoint sweep described below
 * returns the same 22 divergences either way.
 */
const LATIN_MARKS = /(\p{Script=Latin})[\u0300-\u036f]+/gu;

/**
 * Letters unicode61 unifies that `String.prototype.toLowerCase` leaves alone. Measured
 * against the tokenizer, not guessed: `λόγος` indexes as `λόγοσ`, and `ſ` as `s`. `ẛ`
 * needs no entry of its own — NFD splits it into `ſ` plus a mark.
 */
const UNIFY: Record<string, string> = {
  'ſ': 's',
  'ς': 'σ',
  'ϐ': 'β', 'ϑ': 'θ', 'ϕ': 'φ', 'ϖ': 'π', 'ϰ': 'κ', 'ϱ': 'ρ', 'ϵ': 'ε',
};
const UNIFY_RE = new RegExp(`[${Object.keys(UNIFY).join('')}]`, 'gu');

/**
 * Fold a string to the form both sides of the index are compared in: lowercase, Latin
 * diacritics removed, everything else left standing.
 *
 * **Why this exists.** `tokenize()` used to match `[a-z0-9]+` over lowercased text, which
 * is adequate for English and a correctness defect for everything else. On the FTS5
 * backend the document side is folded by SQLite (`remove_diacritics 2`) while the query
 * side was not, so `théorie` reached MATCH as `"th" OR "orie"` — and `"th"` matches 1 904
 * documents of ordinary English prose in the author's library. The result was twenty
 * confident, entirely wrong hits, jaccard 0,00 against the JSON backend (ticket 0009).
 * The repair is Zotero's: fold in JS, in front of the tokeniser that the index side and
 * the query side already share, so the symmetry is structural rather than coincidental.
 *
 * **Why it emulates unicode61 rather than copying Zotero's `normalizeForSearch`.** Zotero
 * folds harder — NFKD, plus a hand map for `ø œ æ ł đ ð þ ß ı` — because it owns both
 * sides of its own comparison. We do not: `passages.body` is the display text `get()`
 * reads back for snippets, so the FTS5 document side stays raw and is tokenised by SQLite.
 * Anything this function does that `unicode61 remove_diacritics 2` does not re-opens the
 * asymmetry it exists to close. Measured, `đại` indexes as `đai` and `søren` as `søren`;
 * folding either here would send the query where the index is not. So the hand map is
 * deliberately absent, and NFD is used rather than NFKD (`ﬁle` and `ａｂｃ` are indexed
 * whole, so they stay whole here).
 *
 * Swept codepoint by codepoint over Latin, Greek, Cyrillic, Latin Extended Additional,
 * letterlike and number forms, fullwidth and the ligatures, 22 residual divergences remain
 * out of 1 287,
 * all rare and all in the direction of retrieving less rather than wrongly: letters whose
 * base is itself non-ASCII Latin (`Ǡ Ǣ Ǯ Ǽ Ǿ`), which NFD decomposes and SQLite's table
 * does not cover, and unassigned codepoints, which unicode61 indexes and `\p{L}` does not.
 */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    // Lowercasing can itself introduce a mark (`İ` → `i` + U+0307), so decompose after it.
    .normalize('NFD')
    .replace(LATIN_MARKS, '$1')
    // Recompose what was kept: the token class below excludes marks, exactly as unicode61
    // treats them as separators, so a decomposed `ά` left standing would split in two.
    .normalize('NFC')
    .replace(UNIFY_RE, (c) => UNIFY[c]!);
}

/**
 * Fold, split on non-alphanumerics, drop stopwords and 1-char tokens.
 *
 * The token class is `\p{L}\p{N}`, not `[a-z0-9]`, and that half earns its place on its
 * own: it keeps `théorie`, `Θεωρία`, `теория` and `日本語` single tokens instead of
 * fragments, and it would have prevented this defect even without the fold — a whole token
 * misses cleanly, a fragment matches a high-frequency English string.
 */
export function tokenize(text: string): string[] {
  return (normalizeForSearch(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'by', 'as', 'at', 'that', 'this', 'it', 'from', 'we', 'our', 'their', 'its', 'these', 'those',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

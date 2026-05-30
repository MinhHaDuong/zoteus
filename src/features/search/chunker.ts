export interface Chunk {
  index: number;
  text: string;
}

/** Split text into overlapping passages on word boundaries. */
export function chunkText(text: string, size = 512, overlap = 64): Chunk[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= size) return [{ index: 0, text: clean }];

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(' ', end);
      if (lastSpace > start + size / 2) end = lastSpace;
    }
    chunks.push({ index: index++, text: clean.slice(start, end).trim() });
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export interface OffsetChunk {
  index: number;
  text: string;
  /** Inclusive char offset of `text` in the source string. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/**
 * Like chunkText, but operates on the RAW text (no whitespace collapsing) and
 * returns each passage's [start,end) char offsets in the source, with both ends
 * snapped to word boundaries so a passage never begins or ends mid-word. Used by
 * full-text passage retrieval (W1) to produce char/section/page locators.
 */
export function chunkWithOffsets(text: string, size = 800, overlap = 100): OffsetChunk[] {
  const len = text.length;
  if (len === 0) return [];
  const isSpace = (i: number) => i < 0 || i >= len || /\s/.test(text[i]!);
  const chunks: OffsetChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < len) {
    while (start < len && isSpace(start)) start++; // skip leading whitespace
    if (start >= len) break;
    if (start > 0 && !isSpace(start - 1)) {
      // we're mid-word: advance past this word + trailing whitespace, BUT only
      // skip when the partial word is short — never strand a token longer than a
      // chunk (that would silently drop its remainder from every passage).
      let s = start;
      while (s < len && !isSpace(s)) s++;
      while (s < len && isSpace(s)) s++;
      if (s < len && s - start < size) start = s;
    }
    let end = Math.min(start + size, len);
    if (end < len) {
      let e = end;
      while (e > start + size / 2 && !isSpace(e)) e--; // snap end back to a word boundary
      if (e > start + size / 2) end = e;
    }
    let realEnd = end;
    while (realEnd > start && isSpace(realEnd - 1)) realEnd--; // trim trailing whitespace
    if (realEnd > start) chunks.push({ index: index++, text: text.slice(start, realEnd), start, end: realEnd });
    if (end >= len) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

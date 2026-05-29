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

/**
 * The segmenter's interface: structure signals in, entries out.
 *
 * A segmenter takes a document's extracted text and a list of structure
 * signals, each a set of candidate boundaries with a provenance, and returns
 * entries: a title, a character range in the text, an optional page range, a
 * confidence and the tier that produced the cut. Discovery runs before the
 * extractor and the cut runs after it: a tier reads structure from the PDF or
 * from a structured-text pack, the segmenter cuts the extracted text, and
 * Zotero stays the extractor.
 *
 * seg/1 is the implementation for the empty signal list and the fall-through
 * for every tier that comes up empty or low.
 */

/** Where a structure signal came from. */
export type SignalKind =
  | 'pack-block' // Zotero structured-text pack: block types and page anchors
  | 'outline' // the PDF's embedded outline (bookmark tree), page targets
  | 'layout' // a layout heuristic over positioned text runs
  | 'markup' // HTML headings, for sources that have no pages
  | 'form-feed' // page breaks carried by the extraction itself
  | 'contents-list'; // a parsed front-matter table of contents

/** One candidate boundary inside a signal. */
export interface BoundaryCandidate {
  /** Character offset in the document text where the boundary falls. */
  offset: number;
  /** Heading text at the boundary, when the signal carries one. */
  title?: string;
  /** 1-based page the boundary opens, when the signal carries one. */
  page?: number;
  /** Nesting depth: 1 for a chapter, 2 for a section inside it, and so on. */
  level?: number;
}

/** A set of candidate boundaries with a provenance. */
export interface StructureSignal {
  kind: SignalKind;
  /** Free-form provenance: which tier, which tool, which version. */
  provenance: string;
  boundaries: BoundaryCandidate[];
}

/** A heading found inside an entry, kept so a consumer can build heading paths. */
export interface SectionHeading {
  offset: number;
  title: string;
  level: number;
}

/** One entry: the unit of answer. */
export interface Entry {
  /** Heading text, or null for front matter and synthetic entries. */
  title: string | null;
  /** Ordinal, 0-based, in document order. */
  ordinal: number;
  /** Character range in the document text, end exclusive. */
  charStart: number;
  charEnd: number;
  /** 1-based page range when a page signal was available. */
  pageStart?: number;
  pageEnd?: number;
  /** How the pages were located, when they were. */
  pageKind?: 'form-feed' | 'signal';
  /** True for the confidence-gated fallback cut at paragraph boundaries. */
  synthetic: boolean;
  /** The tier that produced this cut: a signal kind, or the segmenter's own id. */
  tier: string;
  /** Sub-headings inside the entry, document order. */
  sections: SectionHeading[];
}

/** What a segmenter returns for one document. */
export interface SegmentResult {
  entries: Entry[];
  /** Fraction of the text inside confirmed entries, 0..1. */
  confidence: number;
  /** True when the entries are the synthetic fallback. */
  fallback: boolean;
  /** The segmenter identity that produced this result, for the chunker key. */
  segmenter: string;
  /**
   * What the heuristic decided it was looking at: a book cut at its chapters; a
   * collection of independently structured units, each opening on a page whose
   * running header names it (a dictionary or encyclopedia of signed entries, a
   * proceedings); a dictionary read on headword rhythm alone; a document cut
   * where a higher tier's signal said; or nothing it could read.
   */
  documentClass: 'book' | 'collection' | 'dictionary' | 'signalled' | 'unstructured';
  /** Total characters seen. */
  chars: number;
  /** Form feeds seen, i.e. pages when the extraction carries them. */
  formFeeds: number;
}

/** A window of document text, as the extract worker forwards it. */
export interface TextWindow {
  text: string;
  /** Character offset of the window's first character in the whole document. */
  offset: number;
}

/** The streaming shape: feed windows in order, then finish. */
export interface StreamingSegmenter {
  push(window: TextWindow): void;
  finish(): SegmentResult;
}

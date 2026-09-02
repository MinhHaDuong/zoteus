/**
 * seg/1 — the flat-text entry segmenter.
 *
 * A streaming state machine over the text windows the extract worker
 * forwards. It keeps offsets and short heading candidates as state, never the
 * text, and decides the cut set at end of document: a book into chapters, a
 * proceedings into papers, a dictionary into headwords, and everything it
 * cannot read into labelled synthetic entries cut at paragraph boundaries.
 *
 * Primary target class: books and proceedings. Signals, in order of trust:
 * a parsed front-matter contents list used as an answer key that candidate
 * headings are confirmed against (forward-only, monotonic), chapter and
 * section numbering, page-boundary form feeds where the extraction carries
 * them, and a case-shape signal gated on the document's language. The
 * headword rhythm statistic is the dictionary's special case and never
 * applies to the primary class.
 *
 * Determinism: the result is a pure function of the text and the options.
 * Windowing does not change it.
 */

import type {
  BoundaryCandidate,
  Entry,
  SectionHeading,
  SegmentResult,
  StreamingSegmenter,
  StructureSignal,
  TextWindow,
} from './types.js';

/** Identity string, folded into the chunker key. Bump on any change to the cut rules. */
export const SEG1_ID = 'seg/1';

/** Synthetic entry size, in estimated tokens: about twenty chunks or a short chapter. */
export const SYNTHETIC_TOKENS = 12_000;

/** Below this fraction of text inside confirmed entries, the fallback fires. */
export const CONFIDENCE_GATE = 0.5;

/** Two cuts closer than this merge; the later heading becomes a section. */
export const MIN_ENTRY_CHARS = 1_500;

export interface Seg1Options {
  /** Structure signals from higher tiers. Empty or absent means seg/1's own heuristic. */
  signals?: StructureSignal[];
  syntheticTokens?: number;
  confidenceGate?: number;
  minEntryChars?: number;
}

type CandidateKind =
  | 'chapter'
  | 'numbered'
  | 'roman'
  | 'keyword'
  | 'caps'
  | 'titlecase'
  | 'headword';

interface Candidate {
  offset: number;
  text: string;
  norm: string;
  kind: CandidateKind;
  /** Nesting depth for numbered headings; 1 for the rest. */
  depth: number;
  /** Parsed chapter or top-level number when the line carries one. */
  number: number | null;
  /** Set at decision time. */
  confirmed?: boolean;
  tocMatched?: boolean;
}

interface Cut {
  offset: number;
  title: string | null;
  confirmed: boolean;
  tier: string;
  /** Depth of the heading that made the cut. */
  depth: number;
  candidate: Candidate | null;
  page?: number;
}

const CAPS: Record<CandidateKind, number> = {
  chapter: 50_000,
  numbered: 200_000,
  roman: 50_000,
  keyword: 50_000,
  caps: 50_000,
  titlecase: 50_000,
  headword: 200_000,
};

const MAX_CARRY = 64 * 1024;
const MAX_LINE = 200;
const TOC_SPAN = 64 * 1024;
const TOC_SEARCH = 512 * 1024;
const MAX_TOC_TITLES = 1_000;

const CHAPTER_WORDS =
  'chapter|chapitre|kapitel|capítulo|capitulo|capitolo|chương|part|partie|parte|teil|book|livre';
const CHAPTER_RE = new RegExp(
  `^(?:${CHAPTER_WORDS})\\s+(\\d{1,3}|[ivxlc]{1,7})\\b[\\s.:)\\-–—]*(.*)$`,
  'i',
);
const RUNNING_HEADER_GLUE = new RegExp(
  `^(?:${CHAPTER_WORDS})\\s+(?:\\d{1,3}|[ivxlc]{1,7})\\s+(?=\\d{1,3}(?:\\.\\d{1,3})*[.)]?\\s+\\S)`,
  'i',
);
const NUMBERED_RE = /^(\d{1,3})((?:\.\d{1,3})*)[.)]?\s+(\S.*)$/;
const ROMAN_RE = /^([IVXLC]{1,7})[.)]?\s+(\p{Lu}.{2,150})$/u;
const KEYWORD_RE =
  /^(?:introduction|conclusions?|references|bibliography|bibliographie|références|annexes?|appendix|appendices|annex(?:es)?|glossary|glossaire|index|abstract|résumé|summary|acknowledg(?:e)?ments|remerciements|foreword|preface|préface|avant-propos|contents|table of contents|sommaire|table des matières|list of figures|liste des figures|list of tables|liste des tableaux|executive summary|synthèse|methodology|méthodologie|discussion|results|résultats)\b.{0,40}$/iu;
const CONTENTS_RE = /^(?:contents|table of contents|sommaire|table des matières|inhalt(?:sverzeichnis)?|índice|indice|mục lục)\b/iu;
const LIST_RE = /^(?:list of|liste des|table des|index of)\b/iu;
const LEADER_RE = /^(.*?\S)\s*(?:[.·]\s?){4,}\s*(\d{1,4}|[ivxlc]{1,7})?\s*$/iu;
const PAGE_TAIL_RE = /^(.*?\S)\s{2,}(\d{1,4}|[ivxlc]{1,7})$/iu;
const NUMBERED_PAGE_TAIL_RE = /^(\d{1,3}(?:\.\d{1,3})*[.)]?\s+\p{L}[^\d]{2,100}?)\s(\d{1,4})$/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const EN_WORDS = /\b(?:the|and|of|with)\b/g;
const FR_WORDS = /\b(?:les|des|une|dans|avec)\b/g;
const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'by', 'at', 'from', 'with', 'as',
]);

/** Accent-fold, case-fold, strip numbering and leaders: the comparison form of a heading. */
export function normalizeHeading(s: string): string {
  let t = s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  t = t.replace(/^\s*(?:(?:chapter|chapitre|kapitel|capitulo|capitolo|part|partie)\s+)?[\divxlc]+(?:[.)\-–]|\s)+/u, '');
  t = t.replace(/[\s.·]{3,}[\divxlc]*\s*$/u, '');
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return t;
}

/**
 * The comparison form of a running header: accent- and case-folded, digits dropped so a
 * page number does not make every page distinct, and cut at the first separator so a
 * "headword : Title of the Work" header keeps only the part that varies.
 */
export function normalizeHeader(s: string): string {
  const head = s.split(/\s+(?:[:|•·]|[-–—])\s+/u)[0] ?? s;
  return head.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[\p{N}]+/gu, ' ').replace(/[^\p{L}]+/gu, ' ').trim();
}

function romanToInt(s: string): number | null {
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  let prev = 0;
  const lower = s.toLowerCase();
  for (let i = lower.length - 1; i >= 0; i--) {
    const d = v[lower[i]!];
    if (d === undefined) return null;
    if (d < prev) total -= d;
    else {
      total += d;
      prev = d;
    }
  }
  return total > 0 ? total : null;
}

function parseNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  return romanToInt(s);
}

function estimateTokens(s: string): number {
  const cjk = s.match(CJK_RE)?.length ?? 0;
  return cjk + (s.length - cjk) / 4;
}

function countLetters(s: string): { letters: number; upper: number } {
  let letters = 0;
  let upper = 0;
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) {
      letters++;
      if (ch !== ch.toLowerCase()) upper++;
    }
  }
  return { letters, upper };
}

function digitRatio(s: string): number {
  const digits = s.match(/\d/g)?.length ?? 0;
  return s.length === 0 ? 0 : digits / s.length;
}

function isTitleCase(words: string[]): boolean {
  if (words.length < 2 || words.length > 12) return false;
  let capitalized = 0;
  let counted = 0;
  for (const w of words) {
    const first = w[0]!;
    if (!/\p{L}/u.test(first)) return false;
    if (SMALL_WORDS.has(w.toLowerCase())) continue;
    counted++;
    if (first !== first.toLowerCase()) capitalized++;
  }
  return counted > 0 && capitalized === counted;
}

/** How much a cut's heading is trusted when two cuts stand too close. */
function rank(cut: Cut): number {
  const c = cut.candidate;
  if (!c) return 5; // a higher tier's boundary
  switch (c.kind) {
    case 'chapter':
      return 4;
    case 'numbered':
    case 'roman':
      return 3;
    case 'keyword':
      return 2;
    default:
      return c.tocMatched ? 2 : 1;
  }
}

/** How many times a top-level numbering returns to 1 after reaching 2 or more. */
function countRestarts(list: Candidate[]): number {
  let restarts = 0;
  let prev = 0;
  for (const c of list) {
    if (c.number === null) continue;
    if (c.number === 1 && prev >= 2) restarts++;
    prev = c.number;
  }
  return restarts;
}

/** Binary search: number of sorted values strictly below x. */
function countBelow(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class Seg1 implements StreamingSegmenter {
  private readonly opts: Required<Seg1Options>;
  private carry = '';
  private carryOffset = 0;
  private nextOffset = 0;
  private chars = 0;
  private finished = false;

  private readonly formFeeds: number[] = [];
  /** Paragraph boundaries: offset of the line after a blank line, with cumulative tokens. */
  private readonly paraOffsets: number[] = [];
  private readonly paraTokens: number[] = [];
  private tokens = 0;
  private lastLineBlank = true;

  private readonly candidates: Record<CandidateKind, Candidate[]> = {
    chapter: [], numbered: [], roman: [], keyword: [], caps: [], titlecase: [], headword: [],
  };

  private en = 0;
  private fr = 0;

  private tocStart = -1;
  private tocEnd = -1;
  private readonly tocTitles: string[] = [];
  private readonly tocSeen = new Set<string>();
  /** The first contents title that came from a chapter or top-level numbered line: where the body begins. */
  private firstTocHeadNorm: string | null = null;
  /** Consecutive numbered lines ending in a page number, outside any region: a contents page announcing itself. */
  private readonly tailRun: { offset: number; title: string }[] = [];

  /** Running headers: the first line of each page, for the page-header drift signal. */
  private readonly pageHeaderAt: number[] = [];
  private readonly pageHeaderNorm: string[] = [];
  private readonly pageHeaderText: string[] = [];
  private pendingHeaderAt = -1;

  constructor(options: Seg1Options = {}) {
    this.opts = {
      signals: options.signals ?? [],
      syntheticTokens: options.syntheticTokens ?? SYNTHETIC_TOKENS,
      confidenceGate: options.confidenceGate ?? CONFIDENCE_GATE,
      minEntryChars: options.minEntryChars ?? MIN_ENTRY_CHARS,
    };
    for (const sig of this.opts.signals) {
      if (sig.kind !== 'contents-list') continue;
      for (const b of sig.boundaries) if (b.title) this.addTocTitle(b.title);
    }
  }

  push(window: TextWindow): void {
    if (this.finished) throw new Error('seg/1: push after finish');
    if (window.offset !== this.nextOffset) {
      throw new Error(`seg/1: window offset ${window.offset} does not follow ${this.nextOffset}`);
    }
    const text = window.text;
    this.nextOffset += text.length;
    this.chars += text.length;

    let base: number;
    let buf: string;
    if (this.carry.length > 0) {
      base = this.carryOffset;
      buf = this.carry + text;
      this.carry = '';
    } else {
      base = window.offset;
      buf = text;
    }
    let start = 0;
    for (;;) {
      const nl = buf.indexOf('\n', start);
      if (nl < 0) break;
      this.line(buf.slice(start, nl), base + start);
      start = nl + 1;
    }
    if (start < buf.length) {
      const rest = buf.slice(start);
      if (rest.length > MAX_CARRY) {
        this.line(rest, base + start);
      } else {
        this.carry = rest;
        this.carryOffset = base + start;
      }
    }
  }

  private line(raw: string, offset: number): void {
    // Form feeds: page boundaries, and a paragraph boundary too.
    let text = raw;
    let off = offset;
    let ff = 0;
    while (ff < text.length && text[ff] === '\f') ff++;
    if (ff > 0) {
      for (let i = 0; i < ff; i++) this.formFeeds.push(offset + i);
      text = text.slice(ff);
      off += ff;
      this.paragraphBoundary(off);
      this.pendingHeaderAt = off;
    }
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\f') {
        this.formFeeds.push(off + i);
        this.pendingHeaderAt = off + i + 1;
      }
    }
    this.tokens += estimateTokens(text);

    const trimmed = text.replace(/[\u00a0\s]+/g, ' ').trim();
    if (trimmed.length === 0) {
      this.lastLineBlank = true;
      return;
    }
    if (this.lastLineBlank) this.paragraphBoundary(off);
    this.lastLineBlank = false;

    if (this.pendingHeaderAt >= 0) {
      // The first line of a page is its running header, or the heading that opens it.
      if (trimmed.length <= 120 && this.pageHeaderAt.length < 200_000) {
        this.pageHeaderAt.push(this.pendingHeaderAt);
        this.pageHeaderText.push(trimmed);
        this.pageHeaderNorm.push(normalizeHeader(trimmed));
      }
      this.pendingHeaderAt = -1;
    }

    if (trimmed.length > 40) {
      const lower = trimmed.toLowerCase();
      this.en += lower.match(EN_WORDS)?.length ?? 0;
      this.fr += lower.match(FR_WORDS)?.length ?? 0;
    }

    if (this.tocStart >= 0 && off <= this.tocEnd) this.tocLine(trimmed, off);
    else if (off < TOC_SEARCH) {
      // A contents page without a marker line still shows itself: leaders, or a numbered
      // title ending in its page number. Those lines feed the answer key and are not headings.
      const m = LEADER_RE.exec(trimmed);
      if (m && m[2] !== undefined && m[1]!.length <= 120) {
        this.addTocTitle(m[1]!);
        return;
      }
      // One such line is a heading that happens to end in a digit; a run of three is a
      // contents page, and the region opens at its first line, retroactively.
      const tail = trimmed.length <= 120 ? NUMBERED_PAGE_TAIL_RE.exec(trimmed) : null;
      if (tail) {
        this.tailRun.push({ offset: off, title: tail[1]! });
        if (this.tailRun.length >= 3 && this.tocStart < 0) {
          this.tocStart = this.tailRun[0]!.offset;
          this.tocEnd = this.tocStart + TOC_SPAN;
          for (const t of this.tailRun) this.tocLine(t.title, t.offset);
          this.tailRun.length = 0;
        }
      } else {
        this.tailRun.length = 0;
      }
    }

    if (trimmed.length > MAX_LINE) return;
    if (digitRatio(trimmed) > 0.4) return;
    this.classify(trimmed, off);
  }

  private paragraphBoundary(offset: number): void {
    const last = this.paraOffsets.length - 1;
    if (last >= 0 && this.paraOffsets[last] === offset) return;
    this.paraOffsets.push(offset);
    this.paraTokens.push(this.tokens);
  }

  private addTocTitle(title: string): void {
    const norm = normalizeHeading(title);
    if (norm.length < 3 || this.tocSeen.has(norm) || this.tocTitles.length >= MAX_TOC_TITLES) return;
    this.tocSeen.add(norm);
    this.tocTitles.push(norm);
  }

  /**
   * A line inside the contents region. The region closes on content, never on a
   * fixed span alone: at the first heading-shaped line that repeats a title the
   * list already named (the body has begun), or at the first long line without
   * leaders (prose has begun).
   */
  private tocLine(trimmed: string, off: number): void {
    const lead = LEADER_RE.exec(trimmed);
    if (trimmed.length > 300 && !lead) {
      this.tocEnd = off - 1;
      return;
    }
    if (trimmed.length > 120 && !lead) return;
    const chapter = CHAPTER_RE.exec(lead ? lead[1]! : trimmed);
    const numbered = NUMBERED_RE.exec(lead ? lead[1]! : trimmed);
    const topLevel = chapter !== null || (numbered !== null && !numbered[2]);
    const headNorm = chapter ? normalizeHeading(chapter[2]!) : numbered ? normalizeHeading(numbered[3]!) : null;
    // The body begins where the first chapter the list named appears again as a heading.
    // Keywords and deeper numbers repeat inside a list ("Introduction" under every chapter)
    // and must not close it.
    if (topLevel && headNorm !== null && !lead) {
      if (headNorm === this.firstTocHeadNorm || (chapter && this.tocSeen.has(headNorm))) {
        this.tocEnd = off - 1;
        return;
      }
    }
    if (topLevel && headNorm !== null && headNorm.length >= 3 && this.firstTocHeadNorm === null) {
      this.firstTocHeadNorm = headNorm;
    }
    if (lead) {
      this.addTocTitle(lead[1]!);
      return;
    }
    const tail = PAGE_TAIL_RE.exec(trimmed) ?? NUMBERED_PAGE_TAIL_RE.exec(trimmed);
    if (tail) {
      this.addTocTitle(tail[1]!);
      return;
    }
    if (digitRatio(trimmed) > 0.3) return;
    const { letters } = countLetters(trimmed);
    if (letters >= 3 && !/[.!?]$/.test(trimmed)) this.addTocTitle(trimmed);
  }

  private add(kind: CandidateKind, c: Omit<Candidate, 'kind'>): void {
    const arr = this.candidates[kind];
    if (arr.length >= CAPS[kind]) return;
    arr.push({ ...c, kind });
  }

  private classify(line: string, offset: number): void {
    let text = line;
    let off = offset;
    const glue = RUNNING_HEADER_GLUE.exec(text);
    if (glue) {
      text = text.slice(glue[0].length);
      off += glue[0].length;
    }

    if (this.tocStart < 0 && offset < TOC_SEARCH && CONTENTS_RE.test(text) && text.length <= 60) {
      this.tocStart = offset;
      this.tocEnd = offset + TOC_SPAN;
    }

    const chapter = CHAPTER_RE.exec(text);
    if (chapter) {
      const rest = chapter[2]!.trim();
      if (rest.length <= 150 && !/[=]/.test(rest)) {
        this.add('chapter', {
          offset: off, text, norm: normalizeHeading(rest.length > 0 ? rest : text),
          depth: 1, number: parseNumber(chapter[1]!),
        });
        return;
      }
    }

    const numbered = NUMBERED_RE.exec(text);
    if (numbered) {
      const title = numbered[3]!;
      const { letters } = countLetters(title);
      const depth = 1 + (numbered[2]!.match(/\./g)?.length ?? 0);
      // A footnote reads like a numbered heading: "5 The sector is not discussed here, because…".
      // Headings are short and do not end as sentences do.
      const sentence = /[.!?;]$/.test(title) && title.split(' ').length > 8;
      if (
        letters >= 3 && title.length <= (depth === 1 ? 100 : 150) && !/[=]/.test(title) &&
        !sentence && !/https?:\/\//.test(title) &&
        /^[\p{L}"'«“(]/u.test(title) && digitRatio(title) < 0.25
      ) {
        this.add('numbered', {
          offset: off, text, norm: normalizeHeading(title), depth, number: Number(numbered[1]),
        });
        return;
      }
    }

    const roman = ROMAN_RE.exec(text);
    if (roman) {
      this.add('roman', {
        offset: off, text, norm: normalizeHeading(roman[2]!), depth: 1, number: romanToInt(roman[1]!),
      });
      return;
    }

    if (text.length <= 60 && KEYWORD_RE.test(text)) {
      // A contents line or a list of figures or tables names front matter, never an entry.
      if (!CONTENTS_RE.test(text) && !LIST_RE.test(text)) {
        this.add('keyword', { offset: off, text, norm: normalizeHeading(text), depth: 1, number: null });
      }
      return;
    }

    const words = text.split(' ');
    const { letters, upper } = countLetters(text);
    if (letters >= 4 && words.length <= 14 && text.length <= 100 && upper / letters >= 0.9) {
      this.add('caps', { offset: off, text, norm: normalizeHeading(text), depth: 1, number: null });
      return;
    }
    if (text.length <= 90 && !/[.!?:;,]$/.test(text) && isTitleCase(words)) {
      this.add('titlecase', { offset: off, text, norm: normalizeHeading(text), depth: 1, number: null });
    }
    if (text.length <= 40 && words.length <= 4 && letters >= 2 && /^[\p{L}][\p{L}\p{M}'’\- ]*$/u.test(text)) {
      this.add('headword', { offset: off, text, norm: normalizeHeading(text), depth: 1, number: null });
    }
  }

  finish(): SegmentResult {
    if (this.finished) throw new Error('seg/1: finish called twice');
    this.finished = true;
    if (this.carry.length > 0) {
      this.line(this.carry, this.carryOffset);
      this.carry = '';
    }
    this.formFeeds.sort((a, b) => a - b);

    const signalled = this.signalledCuts();
    if (signalled) return this.build(signalled, 'signalled', 1);

    const decided = this.decide();
    if (decided) {
      const { cuts, documentClass } = decided;
      const confidence = this.coverage(cuts);
      if (confidence >= this.opts.confidenceGate) return this.build(cuts, documentClass, confidence);
      return this.synthetic(confidence, documentClass);
    }
    return this.synthetic(0, 'unstructured');
  }

  // ---- higher-tier signals -------------------------------------------------

  private signalledCuts(): Cut[] | null {
    for (const sig of this.opts.signals) {
      if (sig.kind === 'contents-list') continue;
      const bounds = sig.boundaries
        .filter((b) => Number.isInteger(b.offset) && b.offset >= 0 && b.offset <= this.chars)
        .sort((a, b) => a.offset - b.offset);
      if (bounds.length === 0) continue;
      const cuts: Cut[] = [];
      let last = -1;
      for (const b of bounds) {
        if (b.offset === last) continue;
        last = b.offset;
        cuts.push({
          offset: b.offset, title: b.title ?? null, confirmed: true, tier: sig.kind,
          depth: b.level ?? 1, candidate: null, page: b.page,
        });
      }
      return cuts;
    }
    return null;
  }

  // ---- seg/1's own decision -------------------------------------------------

  private afterToc(list: Candidate[]): Candidate[] {
    if (this.tocStart < 0) return list;
    return list.filter((c) => c.offset > this.tocEnd || c.offset < this.tocStart);
  }

  /** Drop running headers: a normalized heading seen three or more times keeps its first body occurrence. */
  private dedupe(list: Candidate[]): Candidate[] {
    const counts = new Map<string, number>();
    for (const c of list) counts.set(c.norm, (counts.get(c.norm) ?? 0) + 1);
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const c of list) {
      const n = counts.get(c.norm) ?? 0;
      if (n >= 3) {
        if (seen.has(c.norm)) continue;
        seen.add(c.norm);
      }
      out.push(c);
    }
    return out;
  }

  /** Forward-only, monotonic alignment of candidates against the contents list. */
  private markToc(list: Candidate[]): number {
    if (this.tocTitles.length === 0) return 0;
    const index = new Map<string, number>();
    this.tocTitles.forEach((t, i) => index.set(t, i));
    let cursor = -1;
    let matched = 0;
    for (const c of list) {
      const i = index.get(c.norm);
      if (i === undefined || i <= cursor) continue;
      cursor = i;
      c.tocMatched = true;
      matched++;
    }
    return matched;
  }

  /** Keep the candidates whose numbers rise; a later restart starts a new run and is dropped when short. */
  private monotonic(list: Candidate[]): Candidate[] {
    const out: Candidate[] = [];
    let prev = 0;
    for (const c of list) {
      if (c.number === null) continue;
      if (c.number > prev && c.number <= prev + 3) {
        out.push(c);
        prev = c.number;
      } else if (c.number === 1 && prev >= 2 && !c.tocMatched) {
        // A restart: running-header echo of chapter one, or a per-chapter numbering scheme. Skip.
        continue;
      }
    }
    return out;
  }

  /**
   * When the document carries a contents list and the run aligns with it, the list is the
   * answer key: members it does not name are footnotes, list items and running headers that
   * happen to count. When nothing aligns, the list may have been parsed wrong; keep the run.
   */
  private gateOnToc(run: Candidate[]): Candidate[] {
    if (this.tocTitles.length < 5) return run;
    const matched = run.filter((c) => c.tocMatched);
    return matched.length >= 2 ? matched : run;
  }

  private decide(): { cuts: Cut[]; documentClass: SegmentResult['documentClass'] } | null {
    const english = this.en >= this.fr;
    const chapters = this.dedupe(this.afterToc(this.candidates.chapter));
    const numbered = this.dedupe(this.afterToc(this.candidates.numbered));
    const roman = this.dedupe(this.afterToc(this.candidates.roman));
    const keyword = this.dedupe(this.afterToc(this.candidates.keyword));
    const caps = this.dedupe(this.afterToc(this.candidates.caps));
    const titlecase = english ? this.dedupe(this.afterToc(this.candidates.titlecase)) : [];

    const all = [...chapters, ...numbered.filter((c) => c.depth === 1), ...roman, ...keyword, ...caps, ...titlecase]
      .sort((a, b) => a.offset - b.offset);
    this.markToc(all);

    let primary: Candidate[] = [];
    let tier = SEG1_ID;
    const chapterRun = this.gateOnToc(this.monotonic(chapters));
    const numberedRun = this.gateOnToc(this.monotonic(numbered.filter((c) => c.depth === 1)));
    const romanRun = this.gateOnToc(this.monotonic(roman));
    if (chapterRun.length >= 2) primary = chapterRun;
    else if (numberedRun.length >= 2) primary = numberedRun;
    else if (romanRun.length >= 2) primary = romanRun;
    for (const c of primary) c.confirmed = true;

    const tocConfirmed = all.filter((c) => c.tocMatched && !c.confirmed);
    for (const c of tocConfirmed) c.confirmed = true;
    if (primary.length === 0 && tocConfirmed.length >= 2) tier = `${SEG1_ID}:contents-list`;

    // Keywords (references, annexes, conclusion) are chapter-level once a structure exists,
    // and carry a book on their own only when at least two of them appear.
    const structural = primary.length + tocConfirmed.length;
    if (structural >= 2 || keyword.length >= 2) for (const c of keyword) c.confirmed = true;

    const confirmed = all.filter((c) => c.confirmed);
    const bookCuts = confirmed.length >= 2 || (confirmed.length === 1 && primary.length >= 1)
      ? this.toCuts(confirmed, tier)
      : null;

    // A collection of independently structured units: each unit restarts its own section
    // numbering, and each opens on a page whose running header names it. Many restarts with
    // few book-level cuts is that shape, and the page headers then carry the boundaries.
    const drift = this.pageHeaderDrift();
    const restarts = countRestarts(numbered.filter((c) => c.depth === 1));
    const collection = drift.length >= 20 && (restarts >= 20 || (bookCuts?.length ?? 0) * 3 <= drift.length);
    if (collection) return { cuts: drift, documentClass: 'collection' };
    if (bookCuts) return { cuts: bookCuts, documentClass: 'book' };
    if (drift.length >= 5) return { cuts: drift, documentClass: 'collection' };

    const dictionary = this.dictionary();
    if (dictionary) return { cuts: dictionary, documentClass: 'dictionary' };
    return null;
  }

  /**
   * Boundaries where the running header changes at a page boundary. Recto and verso pages
   * alternate two headers, so a header is new only when none of the last four pages carried
   * it. The unit's title is the header itself, cut at its separator.
   */
  private pageHeaderDrift(): Cut[] {
    if (this.formFeeds.length < 20) return [];
    const cuts: Cut[] = [];
    const recent: string[] = [];
    const seenTitles = new Set<string>();
    for (let i = 0; i < this.pageHeaderAt.length; i++) {
      const norm = this.pageHeaderNorm[i]!;
      const isNew = norm.length >= 3 && !recent.includes(norm);
      recent.push(norm);
      if (recent.length > 4) recent.shift();
      if (!isNew || seenTitles.has(norm)) continue;
      seenTitles.add(norm);
      const text = this.pageHeaderText[i]!;
      const title = (text.split(/\s+(?:[:|•·]|[-–—])\s+/u)[0] ?? text).trim();
      cuts.push({
        offset: this.pageHeaderAt[i]!, title, confirmed: true, tier: `${SEG1_ID}:page-header`,
        depth: 1, candidate: null,
      });
    }
    // Two headers within a page of each other are one unit: keep the earlier.
    const merged: Cut[] = [];
    for (const cut of cuts) {
      const prev = merged[merged.length - 1];
      if (prev && cut.offset - prev.offset < this.opts.minEntryChars) continue;
      merged.push(cut);
    }
    return merged;
  }

  private toCuts(confirmed: Candidate[], tier: string): Cut[] {
    const cuts: Cut[] = [];
    for (const c of confirmed) {
      const chapterOnly = c.kind === 'chapter' && c.norm.length === 0;
      cuts.push({
        offset: c.offset, title: chapterOnly ? c.text.trim() : c.text.trim(), confirmed: true,
        tier, depth: c.depth, candidate: c,
      });
    }
    // Merge cuts that stand too close. The stronger heading keeps the entry; on a tie the
    // earlier does, and a bare "Chapter N" takes the later line as its title.
    const merged: Cut[] = [];
    for (const cut of cuts) {
      const prev = merged[merged.length - 1];
      if (prev && cut.offset - prev.offset < this.opts.minEntryChars) {
        if (rank(cut) > rank(prev)) {
          merged[merged.length - 1] = cut;
          continue;
        }
        const bare = prev.candidate?.kind === 'chapter' && prev.candidate.norm.length === 0;
        if (bare && cut.title) prev.title = `${prev.title} — ${cut.title}`;
        continue;
      }
      merged.push(cut);
    }
    return merged;
  }

  /** The dictionary's special case: headword rhythm, median gap and MAD over candidate spacing. */
  private dictionary(): Cut[] | null {
    const words = this.dedupe(this.afterToc(this.candidates.headword));
    if (words.length < 200) return null;
    const gaps: number[] = [];
    for (let i = 1; i < words.length; i++) gaps.push(words[i]!.offset - words[i - 1]!.offset);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1]!;
    if (median < 400) return null;
    const dev = gaps.map((g) => Math.abs(g - median)).sort((a, b) => a - b);
    const mad = dev[dev.length >> 1]!;
    if (mad / median > 0.6) return null;
    const cuts: Cut[] = [];
    let lastOffset = -Infinity;
    for (const w of words) {
      if (w.offset - lastOffset < median * 0.35) continue;
      cuts.push({ offset: w.offset, title: w.text, confirmed: true, tier: `${SEG1_ID}:headword`, depth: 1, candidate: w });
      lastOffset = w.offset;
    }
    return cuts.length >= 100 ? cuts : null;
  }

  private coverage(cuts: Cut[]): number {
    if (this.chars === 0) return 0;
    let covered = 0;
    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i]!;
      if (!cut.confirmed) continue;
      const end = i + 1 < cuts.length ? cuts[i + 1]!.offset : this.chars;
      covered += end - cut.offset;
    }
    return Math.min(1, covered / this.chars);
  }

  // ---- building entries ----------------------------------------------------

  private pageAt(offset: number): number | undefined {
    if (this.formFeeds.length === 0) return undefined;
    return 1 + countBelow(this.formFeeds, offset + 1);
  }

  private sectionsIn(start: number, end: number, cutOffsets: Set<number>): SectionHeading[] {
    const out: SectionHeading[] = [];
    const pool = [...this.candidates.numbered, ...this.candidates.chapter, ...this.candidates.roman]
      .filter((c) => c.offset >= start && c.offset < end && !cutOffsets.has(c.offset))
      .sort((a, b) => a.offset - b.offset);
    for (const c of pool) {
      if (out.length >= 200) break;
      out.push({ offset: c.offset, title: c.text.trim(), level: c.depth + 1 });
    }
    return out;
  }

  private build(cuts: Cut[], documentClass: SegmentResult['documentClass'], confidence: number): SegmentResult {
    const entries: Entry[] = [];
    const cutOffsets = new Set(cuts.map((c) => c.offset));
    const first = cuts[0];
    let ordinal = 0;
    if (!first || first.offset > 0) {
      const end = first ? first.offset : this.chars;
      entries.push(this.entry(ordinal++, null, 0, end, false, SEG1_ID, cutOffsets, undefined));
    }
    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i]!;
      const end = i + 1 < cuts.length ? cuts[i + 1]!.offset : this.chars;
      if (end <= cut.offset) continue;
      entries.push(this.entry(ordinal++, cut.title, cut.offset, end, false, cut.tier, cutOffsets, cut.page));
    }
    return {
      entries, confidence, fallback: false, segmenter: SEG1_ID, documentClass,
      chars: this.chars, formFeeds: this.formFeeds.length,
    };
  }

  private entry(
    ordinal: number, title: string | null, start: number, end: number, synthetic: boolean,
    tier: string, cutOffsets: Set<number>, signalPage: number | undefined,
  ): Entry {
    const e: Entry = {
      title, ordinal, charStart: start, charEnd: end, synthetic, tier,
      sections: synthetic ? [] : this.sectionsIn(start, end, cutOffsets),
    };
    if (signalPage !== undefined) {
      e.pageStart = signalPage;
      e.pageKind = 'signal';
    } else {
      const p = this.pageAt(start);
      if (p !== undefined) {
        e.pageStart = p;
        e.pageEnd = this.pageAt(Math.max(start, end - 1));
        e.pageKind = 'form-feed';
      }
    }
    return e;
  }

  private synthetic(confidence: number, documentClass: SegmentResult['documentClass']): SegmentResult {
    const entries: Entry[] = [];
    const budget = this.opts.syntheticTokens;
    const none = new Set<number>();
    let start = 0;
    let startTokens = 0;
    let ordinal = 0;
    for (let i = 0; i < this.paraOffsets.length; i++) {
      const off = this.paraOffsets[i]!;
      const tok = this.paraTokens[i]!;
      if (off <= start) continue;
      if (tok - startTokens >= budget) {
        entries.push(this.entry(ordinal++, null, start, off, true, SEG1_ID, none, undefined));
        start = off;
        startTokens = tok;
      }
    }
    if (this.paraOffsets.length === 0 && this.chars > 0) {
      // No paragraph boundary at all: cut at fixed character positions, the honest last resort.
      const step = Math.max(1, Math.round(budget * 4));
      while (this.chars - start > step) {
        entries.push(this.entry(ordinal++, null, start, start + step, true, SEG1_ID, none, undefined));
        start += step;
      }
    }
    if (start < this.chars || entries.length === 0) {
      entries.push(this.entry(ordinal++, null, start, this.chars, true, SEG1_ID, none, undefined));
    }
    return {
      entries, confidence, fallback: true, segmenter: SEG1_ID, documentClass,
      chars: this.chars, formFeeds: this.formFeeds.length,
    };
  }
}

/** A streaming seg/1: feed windows in order, then `finish()`. */
export function createSeg1(options: Seg1Options = {}): StreamingSegmenter {
  return new Seg1(options);
}

/** One-shot convenience over a whole text. Identical result to the streaming form. */
export function segment(text: string, options: Seg1Options = {}): SegmentResult {
  const s = new Seg1(options);
  s.push({ text, offset: 0 });
  return s.finish();
}

export type { BoundaryCandidate, Entry, SegmentResult, StructureSignal, TextWindow };

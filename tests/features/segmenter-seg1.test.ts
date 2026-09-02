import { describe, it, expect } from 'vitest';
import {
  SEG1_ID,
  SYNTHETIC_TOKENS,
  createSeg1,
  normalizeHeading,
  segment,
} from '../../src/features/search/segmenter/seg1.js';
import type { SegmentResult, StructureSignal } from '../../src/features/search/segmenter/types.js';

// ---- fixtures: shapes taken from real extractions, text invented -------------

function para(seed: number, sentences = 6): string {
  const words = ['energy', 'storage', 'capture', 'model', 'region', 'policy', 'cost', 'scenario', 'market', 'the', 'of', 'and'];
  const out: string[] = [];
  for (let s = 0; s < sentences; s++) {
    const n = 12 + ((seed + s) % 7);
    const w: string[] = [];
    for (let i = 0; i < n; i++) w.push(words[(seed * 7 + s * 3 + i) % words.length]!);
    out.push(w.join(' ') + '.');
  }
  return out.join(' ');
}

function paraFr(seed: number, sentences = 6): string {
  const words = ['les', 'réacteurs', 'des', 'procédés', 'une', 'biomasse', 'dans', 'énergie', 'avec', 'pyrolyse', 'et', 'la'];
  const out: string[] = [];
  for (let s = 0; s < sentences; s++) {
    const n = 12 + ((seed + s) % 7);
    const w: string[] = [];
    for (let i = 0; i < n; i++) w.push(words[(seed * 7 + s * 3 + i) % words.length]!);
    out.push(w.join(' ') + '.');
  }
  return out.join(' ');
}

const BOOK_CHAPTERS = [
  'INTRODUCTION',
  'THE WORLD ENERGY SYSTEM',
  'CCS CHARACTERISTICS',
  'BASIC RESULTS FROM THE MODEL ANALYSIS',
  'CHALLENGES AHEAD',
];

/** An English report-style book: contents without leaders, chapter lines, running headers, form feeds. */
function englishBook(withFormFeeds = true): string {
  const ff = withFormFeeds ? '\f' : '';
  const lines: string[] = [];
  lines.push('INTERNATIONAL AGENCY', 'PROSPECTS FOR CAPTURE AND STORAGE', '', 'FOREWORD', '', para(1, 8), '', para(2, 8), '');
  lines.push(`${ff}TABLE OF CONTENTS`, '');
  BOOK_CHAPTERS.forEach((c, i) => {
    lines.push(`${i + 1}. ${c[0]}${c.slice(1).toLowerCase()}`, `${20 + i * 30}`, '');
  });
  lines.push('');
  BOOK_CHAPTERS.forEach((c, i) => {
    lines.push(`${ff}Chapter ${i + 1}. ${c}`, '');
    for (let p = 0; p < 9; p++) {
      if (p > 0 && p % 3 === 0) lines.push(`${ff}${i + 1}. ${c}`, `${21 + i * 30 + p}`, '');
      lines.push(para(i * 10 + p, 7), '');
    }
    lines.push(`${i + 1}.1 A section inside chapter ${i + 1}`, '', para(i * 10 + 50, 5), '');
  });
  lines.push(`${ff}REFERENCES`, '', para(90, 4), '');
  return lines.join('\n');
}

/** A French thesis: leaders in the contents, chapter lines, section numbering restarting per chapter, NBSP, glued running headers. */
function frenchThesis(): string {
  const nb = ' ';
  const lines: string[] = [];
  lines.push('THESE', `En${nb}vue${nb}de${nb}l’obtention${nb}du DOCTORAT`, 'PYROLYSE EN LIT FIXE CONTINU', '', 'Remerciements', '', paraFr(1), '');
  lines.push('Table des matières', '');
  lines.push('Remerciements ............................................................ i');
  lines.push('Chapitre 1 Contexte et enjeux de l’étude ................................ 1');
  lines.push('1.1 Transition énergétique ............................................. 3');
  lines.push('Chapitre 2 Etude bibliographique ...................................... 25');
  lines.push('Chapitre 3 Matériel et méthodes ....................................... 61');
  lines.push('Chapitre 4 Résultats .................................................. 99');
  lines.push('Conclusion générale .................................................. 150');
  lines.push('');
  const chapters = ['Contexte et enjeux de l’étude', 'Etude bibliographique', 'Matériel et méthodes', 'Résultats'];
  chapters.forEach((t, i) => {
    lines.push(`Chapitre ${i + 1} ${t}`, '');
    for (let s = 1; s <= 3; s++) {
      lines.push(`${s} Section ${s} du chapitre ${i + 1}`, '', paraFr(i * 10 + s, 8), '');
      lines.push(`Chapitre ${i + 1} ${s}.1 Sous-section glued to the running header`, '', paraFr(i * 10 + s + 5, 8), '');
    }
  });
  lines.push('Conclusion générale', '', paraFr(80, 6), '');
  return lines.join('\n');
}

/** A dictionary: headwords on their own line, entries of near-uniform length. */
function dictionary(n = 320): string {
  const lines: string[] = [];
  lines.push('A DICTIONARY OF THINGS', '', 'PREFACE', '', para(0, 5), '');
  for (let i = 0; i < n; i++) lines.push(headword(i), '', para(i + 100, 5 + (i % 2)), '');
  return lines.join('\n');
}

/** Letters only: "Headword" plus a base-26 suffix, so the line reads as a word. */
function headword(i: number): string {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return `Headword${a[Math.floor(i / 26) % 26]}${a[i % 26]}`;
}

/** Structureless prose: paragraphs only. About 200 000 characters. */
function unstructured(): string {
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) lines.push(para(i, 6), '');
  return lines.join('\n');
}

function titles(r: SegmentResult): (string | null)[] {
  return r.entries.map((e) => e.title);
}

function streamed(text: string, windowChars: number): SegmentResult {
  const s = createSeg1();
  for (let off = 0; off < text.length; off += windowChars) {
    s.push({ text: text.slice(off, off + windowChars), offset: off });
  }
  return s.finish();
}

// ---- tests ------------------------------------------------------------------

describe('seg/1 on the primary class: an English book', () => {
  const text = englishBook();
  const r = segment(text);

  it('cuts at chapter lines, confirmed against the contents list, and never inside the contents', () => {
    expect(r.fallback).toBe(false);
    expect(r.documentClass).toBe('book');
    const t = titles(r);
    expect(t[0]).toBeNull(); // front matter
    for (let i = 0; i < BOOK_CHAPTERS.length; i++) {
      expect(t).toContain(`Chapter ${i + 1}. ${BOOK_CHAPTERS[i]}`);
    }
    expect(t).toContain('REFERENCES');
    // Running headers ("1. INTRODUCTION" repeated on every page) produce no extra entries;
    // the foreword before the contents is an entry of its own.
    expect(t.filter((x) => x !== null && /^\d/.test(x))).toHaveLength(0);
    expect(t).toContain('FOREWORD');
    expect(r.entries.length).toBe(1 + 1 + BOOK_CHAPTERS.length + 1);
    // Entries tile the document in order.
    for (let i = 1; i < r.entries.length; i++) {
      expect(r.entries[i]!.charStart).toBe(r.entries[i - 1]!.charEnd);
    }
    expect(r.entries[r.entries.length - 1]!.charEnd).toBe(text.length);
  });

  it('reports confidence as the fraction of text inside confirmed entries', () => {
    const front = r.entries[0]!;
    expect(r.confidence).toBeCloseTo((text.length - front.charEnd) / text.length, 6);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('locates pages from form feeds when the extraction carries them', () => {
    expect(r.formFeeds).toBeGreaterThan(0);
    const ch1 = r.entries.find((e) => e.title?.startsWith('Chapter 1.'))!;
    expect(ch1.pageKind).toBe('form-feed');
    expect(ch1.pageStart).toBe(3); // title page, contents page, then chapter 1
    const ch2 = r.entries.find((e) => e.title?.startsWith('Chapter 2.'))!;
    expect(ch2.pageStart!).toBeGreaterThan(ch1.pageStart!);
    expect(ch1.pageEnd!).toBeLessThanOrEqual(ch2.pageStart!);
  });

  it('keeps sub-headings as sections inside the entry', () => {
    const ch2 = r.entries.find((e) => e.title?.startsWith('Chapter 2.'))!;
    expect(ch2.sections.map((s) => s.title)).toContain('2.1 A section inside chapter 2');
  });

  it('gives the same answer without form feeds, minus the pages', () => {
    const r2 = segment(englishBook(false));
    expect(titles(r2)).toEqual(titles(r));
    expect(r2.entries[1]!.pageStart).toBeUndefined();
    expect(r2.formFeeds).toBe(0);
  });
});

describe('seg/1 on a French thesis', () => {
  const text = frenchThesis();
  const r = segment(text);

  it('cuts at "Chapitre N" lines and treats the per-chapter numbering as sections', () => {
    expect(r.fallback).toBe(false);
    const t = titles(r);
    expect(t).toContain('Chapitre 1 Contexte et enjeux de l’étude');
    expect(t).toContain('Chapitre 4 Résultats');
    expect(t).toContain('Conclusion générale');
    // "1 Section 1 du chapitre 2" restarts numbering and must not become an entry.
    expect(t.filter((x) => x?.startsWith('1 Section'))).toHaveLength(0);
    const ch2 = r.entries.find((e) => e.title?.startsWith('Chapitre 2'))!;
    expect(ch2.sections.map((s) => s.title)).toContain('1 Section 1 du chapitre 2');
  });

  it('strips a running header glued onto a numbered heading', () => {
    const ch3 = r.entries.find((e) => e.title?.startsWith('Chapitre 3'))!;
    const glued = ch3.sections.find((s) => s.title.includes('Sous-section'));
    expect(glued).toBeDefined();
    expect(glued!.title.startsWith('Chapitre')).toBe(false);
    expect(glued!.title.startsWith('1.1')).toBe(true);
  });

  it('does not use Title Case as a signal on French text', () => {
    // A French document with a Title-Case-looking line that is prose, not a heading.
    const t = frenchThesis() + '\nLes Réacteurs Des Procédés Une Biomasse\n\n' + paraFr(99) + '\n';
    const r2 = segment(t);
    expect(titles(r2)).not.toContain('Les Réacteurs Des Procédés Une Biomasse');
  });
});

describe('seg/1 on the rare case: a dictionary', () => {
  it('accepts headwords on their rhythm, and only there', () => {
    const r = segment(dictionary());
    expect(r.fallback).toBe(false);
    expect(r.documentClass).toBe('dictionary');
    expect(r.entries.length).toBeGreaterThanOrEqual(300);
    expect(r.entries[1]!.tier).toBe(`${SEG1_ID}:headword`);
    expect(titles(r)).toContain(headword(42));
  });

  it('never applies the rhythm statistic to a book', () => {
    const r = segment(englishBook());
    expect(r.documentClass).toBe('book');
    expect(r.entries.every((e) => e.tier === SEG1_ID)).toBe(true);
  });
});

/**
 * A collection of signed entries printed one per page run, the shape of a web-printed
 * encyclopedia: each entry opens on a page whose running header names it, restarts its own
 * section numbering, and repeats the same boilerplate lines.
 */
function signedEncyclopedia(n = 40): string {
  const lines: string[] = ['THE ENCYCLOPEDIA', '', 'PREFACE', '', para(0, 5), ''];
  for (let i = 0; i < n; i++) {
    const head = `${headword(i)} entry`;
    const pages = 2 + (i % 3);
    for (let p = 0; p < pages; p++) {
      lines.push(`\f${head} : The Encyclopedia of Things`);
      if (p === 0) {
        lines.push('The Encyclopedia of Things Online', head, `Author ${headword(i + 7)}`, 'Abstract', '', para(i + 200, 4), '', 'Keywords', '');
        lines.push('1 Origins', '', para(i + 300, 6), '', '2 Debates', '', para(i + 400, 6), '');
      } else {
        lines.push('', para(i * 10 + p + 500, 8), '', `${p + 2} Further debates`, '', para(i * 10 + p + 600, 6), '');
      }
      if (p === pages - 1) lines.push('Bibliography', '', para(i + 700, 3), '');
    }
  }
  return lines.join('\n');
}

describe('seg/1 on a collection: signed entries, one per page run', () => {
  const text = signedEncyclopedia();
  const r = segment(text);

  it('cuts where the running header changes at a page boundary and titles the unit by the header', () => {
    expect(r.fallback).toBe(false);
    expect(r.documentClass).toBe('collection');
    const t = titles(r);
    expect(t).toContain(`${headword(0)} entry`);
    expect(t).toContain(`${headword(39)} entry`);
    expect(r.entries.filter((e) => e.title !== null)).toHaveLength(40);
    expect(r.entries[1]!.tier).toBe(`${SEG1_ID}:page-header`);
    expect(r.entries[1]!.pageKind).toBe('form-feed');
  });

  it('does not read the per-entry numbering as chapters of one book', () => {
    expect(titles(r).some((x) => x?.startsWith('1 Origins'))).toBe(false);
    expect(titles(r).filter((x) => x === 'Bibliography')).toHaveLength(0);
  });

  it('keeps a chaptered book a book even when it carries page headers', () => {
    expect(segment(englishBook()).documentClass).toBe('book');
  });
});

describe('seg/1 below the confidence gate', () => {
  const text = unstructured();
  const r = segment(text);

  it('falls back to synthetic entries of about the budget, cut at paragraph boundaries', () => {
    expect(r.fallback).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.entries.every((e) => e.synthetic && e.title === null)).toBe(true);
    expect(r.entries.length).toBeGreaterThan(2);
    for (const e of r.entries) {
      // Each cut lands right after a blank line.
      if (e.charStart > 0) expect(text.slice(e.charStart - 2, e.charStart)).toBe('\n\n');
      const tokens = (e.charEnd - e.charStart) / 4;
      expect(tokens).toBeLessThan(SYNTHETIC_TOKENS * 1.2);
    }
    expect(r.entries[r.entries.length - 1]!.charEnd).toBe(text.length);
  });

  it('honours a smaller budget', () => {
    const r2 = segment(text, { syntheticTokens: 2000 });
    expect(r2.entries.length).toBeGreaterThan(r.entries.length * 3);
  });

  it('labels an empty document as one empty synthetic entry', () => {
    const r3 = segment('');
    expect(r3.fallback).toBe(true);
    expect(r3.entries).toHaveLength(1);
    expect(r3.entries[0]!.charEnd).toBe(0);
  });
});

describe('seg/1 as a streaming state machine', () => {
  it('gives the same result whatever the window size, including windows that split a line', () => {
    for (const text of [englishBook(), frenchThesis(), dictionary(220), unstructured()]) {
      const whole = segment(text);
      for (const w of [7, 1000, 64 * 1024]) {
        expect(streamed(text, w)).toEqual(whole);
      }
    }
  });

  it('is deterministic', () => {
    const a = segment(englishBook());
    const b = segment(englishBook());
    expect(a).toEqual(b);
  });

  it('refuses windows out of order and pushes after finish', () => {
    const s = createSeg1();
    s.push({ text: 'abc', offset: 0 });
    expect(() => s.push({ text: 'def', offset: 5 })).toThrow(/does not follow/);
    s.finish();
    expect(() => s.push({ text: 'x', offset: 3 })).toThrow(/after finish/);
  });

  it('names itself for the chunker key', () => {
    expect(segment('hello').segmenter).toBe(SEG1_ID);
    expect(SEG1_ID).toBe('seg/1');
  });
});

describe('seg/1 with structure signals from a higher tier', () => {
  it('cuts where the signal says and records the tier', () => {
    const text = unstructured();
    const outline: StructureSignal = {
      kind: 'outline',
      provenance: 'pdf.js getOutline',
      boundaries: [
        { offset: 0, title: 'Front', page: 1, level: 1 },
        { offset: 50_000, title: 'Part one', page: 12, level: 1 },
        { offset: 120_000, title: 'Part two', page: 30, level: 1 },
      ],
    };
    const r = segment(text, { signals: [outline] });
    expect(r.fallback).toBe(false);
    expect(r.documentClass).toBe('signalled');
    expect(r.confidence).toBe(1);
    expect(titles(r)).toEqual(['Front', 'Part one', 'Part two']);
    expect(r.entries.map((e) => e.tier)).toEqual(['outline', 'outline', 'outline']);
    expect(r.entries[1]!.pageStart).toBe(12);
    expect(r.entries[1]!.pageKind).toBe('signal');
    expect(r.entries[2]!.charEnd).toBe(text.length);
  });

  it('falls through to its own heuristic when every signal is empty', () => {
    const empty: StructureSignal = { kind: 'outline', provenance: 'pdf.js getOutline', boundaries: [] };
    const r = segment(englishBook(), { signals: [empty] });
    expect(r.documentClass).toBe('book');
  });

  it('takes a contents-list signal as the answer key rather than as cuts', () => {
    // Caps lines alone are weak; a contents list naming them confirms them.
    const lines: string[] = ['A REPORT', ''];
    const heads = ['OVERVIEW OF THE PROBLEM', 'WHAT THE DATA SHOW', 'WHAT SHOULD BE DONE'];
    for (const [i, h] of heads.entries()) {
      lines.push(h, '');
      for (let p = 0; p < 6; p++) lines.push(para(i * 10 + p, 7), '');
    }
    const text = lines.join('\n');
    const weak = segment(text);
    expect(weak.fallback).toBe(true);
    const toc: StructureSignal = {
      kind: 'contents-list',
      provenance: 'test',
      boundaries: heads.map((h) => ({ offset: 0, title: h })),
    };
    const strong = segment(text, { signals: [toc] });
    expect(strong.fallback).toBe(false);
    expect(titles(strong).slice(1)).toEqual(heads);
    expect(strong.entries[1]!.tier).toBe(`${SEG1_ID}:contents-list`);
  });
});

describe('normalizeHeading', () => {
  it('folds accents and case, strips numbering, leaders and page numbers', () => {
    expect(normalizeHeading('Chapitre 2 Étude bibliographique ........ 25')).toBe('etude bibliographique');
    expect(normalizeHeading('2. THE WORLD ENERGY SYSTEM')).toBe('the world energy system');
    expect(normalizeHeading('III. Résultats')).toBe('resultats');
  });
});

/** Known identifier families; `(string & {})` keeps literal autocomplete while allowing extras. */
export type IdentifierType = 'doi' | 'arxiv' | 'pmid' | 'isbn' | 'bibcode' | (string & {});

/**
 * Classify a bare identifier or identifier-URL into {type, value}. Returns
 * null for free text and for URLs this module cannot route (web pages).
 */
export function parseIdentifier(v: string): { type: IdentifierType; value: string } | null {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;

  // DOI with or without the https://doi.org/ or https://dx.doi.org/ prefix
  const doi = s.match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.[0-9]{4,}(?:\.[0-9]+)*\/\S+)$/i);
  if (doi?.[1]) return { type: 'doi', value: doi[1] };

  // arXiv ids, also via arxiv.org/abs/ export.arxiv.org/abs/ or /pdf/
  const arxiv = s.match(/^(?:https?:\/\/[^/]*(?:arxiv\.org|export\.arxiv\.org)\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i);
  if (arxiv?.[1]) return { type: 'arxiv', value: arxiv[1].toLowerCase() };

  // arXiv legacy ids like "math.GT/0309136"
  const legacy = s.match(/^(?:https?:\/\/[^/]*(?:arxiv\.org|export\.arxiv\.org)\/(?:abs|pdf)\/)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i);
  if (legacy?.[1]) return { type: 'arxiv', value: legacy[1].toLowerCase() };

  // PMID (also via pubmed.ncbi.nlm.nih.gov/)
  const pmid = s.match(/^(?:https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)?(\d{1,9})$/);
  if (pmid?.[1]) return { type: 'pmid', value: pmid[1] };

  // ISBN-10/13 (also via isbnsearch.org/ or search.worldcat.org/)
  const isbn = s.match(/^(?:https?:\/\/[^/]*(?:isbnsearch\.org|search\.worldcat\.org)\/[^/]*\/)?(?:isbn(?:-1[03])?:?\s*)?(\d{9}[\dXx]|\d{13})$/i);
  if (isbn?.[1]) return { type: 'isbn', value: isbn[1].toUpperCase() };

  // ADS bibcodes: 19 uppercase chars (1 digit + 4 year + 5 ref + 9 bib)
  const bibcode = s.match(/^(?:https?:\/\/ui\.adsabs\.harvard\.edu\/abs\/)?(\d{19})$/i);
  if (bibcode?.[1]) return { type: 'bibcode', value: bibcode[1] };

  // Loose arXiv ids (e.g. "2201.00001v2" already matched above; this catches
  // odd-but-plausible forms)
  const looseArxiv = s.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/);
  if (looseArxiv?.[1]) return { type: 'arxiv', value: looseArxiv[1] };

  return null;
}

/** Strip a DOI like "https://dx.doi.org/10.1234/abc" down to "10.1234/abc". */
export function bareDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

/** Core Zotero item fields our resolver can always produce. */
export interface ResolvedItem {
  itemType: string;
  title: string;
  creators: Array<{ creatorType: 'author'; firstName?: string; lastName?: string; name?: string }>;
  date?: string;
  DOI?: string;
  url?: string;
  extra?: string;
  publicationTitle?: string;
  abstractNote?: string;
  [key: string]: unknown;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/* ------------------------------------------------------------------ *
 * Minimal Atom extractor.
 *
 * arXiv's export feed is machine-generated and entity-encoded (no raw "<"
 * inside text content), so a small single-level tag extractor is safe for
 * exactly this feed shape. Do NOT reuse for arbitrary XML.
 * ------------------------------------------------------------------ */

const TEXT_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&#x([0-9a-fA-F]+);|&#(\d+);|&([a-zA-Z]+);/g, (m, hex, dec, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    if (named !== undefined) return TEXT_ENTITIES[named] ?? m;
    return m;
  });
}

/** First <tag>text</tag> group in xml (namespaced tags like arxiv:doi work). */
function atomField(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  const body = m?.[1];
  if (body === undefined) return undefined;
  return decodeEntities(body).trim();
}

/** All <author><name>..</name></author> groups. */
function atomAuthors(xml: string): string[] {
  const names: string[] = [];
  const re = /<author[^>]*>([\s\S]*?)<\/author>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const nm = body?.match(/<name[^>]*>([\s\S]*?)<\/name>/);
    const name = nm?.[1];
    if (name !== undefined) names.push(decodeEntities(name).trim());
  }
  return names;
}

/** One arXiv feed entry. */
interface AtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  authors: string[];
  doi?: string;
  journalRef?: string;
}

function parseEntry(entryXml: string): AtomEntry {
  return {
    id: atomField(entryXml, 'id'),
    title: atomField(entryXml, 'title'),
    summary: atomField(entryXml, 'summary'),
    published: atomField(entryXml, 'published'),
    authors: atomAuthors(entryXml),
    doi: atomField(entryXml, 'arxiv:doi'),
    journalRef: atomField(entryXml, 'arxiv:journal_ref'),
  };
}

function nameParts(full: string): { firstName?: string; lastName?: string; name?: string } {
  const s = full.trim();
  if (!s) return {};
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { name: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
}

/* ------------------------------------------------------------------ */

const ABSTRACT_MAX = 2000;

/**
 * Look up an arXiv id. The arXiv record itself is the source of record:
 * unlike DOI services, arXiv publishes no pre-registered "preferred journal
 * version" for an id, so the feed's own title/authors/date are used directly.
 * When the record carries a journal_ref the item is typed journalArticle
 * (the arXiv id is still retained in extra for traceability).
 */
/**
 * arXiv API etiquette: at most ~1 request per 3 seconds. All arXiv calls are
 * serialized through one paced chain so batch imports do not provoke HTTP 429.
 * Tests may lower the gap via setArxivMinGapMs(0).
 */
let ARXIV_MIN_GAP_MS = 3_000;
let lastArxivRequestAt = 0;
let arxivChain: Promise<unknown> = Promise.resolve();

export function setArxivMinGapMs(ms: number): void {
  ARXIV_MIN_GAP_MS = ms;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pacedArxiv<T>(fn: () => Promise<T>): Promise<T> {
  const run = arxivChain.then(async () => {
    const wait = lastArxivRequestAt + ARXIV_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleepMs(wait);
    lastArxivRequestAt = Date.now();
    return fn();
  });
  arxivChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Fetch an arXiv URL, backing off on throttle signals (429/503) instead of failing. */
async function arxivFetchWithBackoff(url: string, fetcher: Fetcher): Promise<Response> {
  const init = { method: 'GET', headers: { accept: 'application/atom+xml' } };
  let res = await fetcher(url, init);
  for (let attempt = 0; (res.status === 429 || res.status === 503) && attempt < 2; attempt++) {
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const wait =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 15_000)
        : 3_000 * (attempt + 1);
    await sleepMs(wait);
    lastArxivRequestAt = Date.now();
    res = await fetcher(url, init);
  }
  return res;
}

export async function arxivItem(id: string, fetcher: Fetcher): Promise<ResolvedItem | null> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`;
  const res = await pacedArxiv(() => arxivFetchWithBackoff(url, fetcher));
  if (res.status === 429 || res.status === 503) {
    // Throttled even after backoff. Do NOT report "no record": the id was never checked.
    throw new Error(
      `arXiv is rate-limiting us (HTTP ${res.status}). Wait a minute and retry — "${id}" was not checked.`,
    );
  }
  if (!res.ok) return null;
  const xml = await res.text();
  const entryXml = xml.match(/<entry[^>]*>([\s\S]*?)<\/entry>/);
  const body = entryXml?.[1];
  if (body === undefined) return null;
  const e = parseEntry(body);
  const title = (e.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const item: ResolvedItem = {
    itemType: e.journalRef ? 'journalArticle' : 'preprint',
    title,
    creators: e.authors.map((a) => ({ creatorType: 'author' as const, ...nameParts(a) })),
    extra: `arXiv:${id}`,
    url: e.id ?? `https://arxiv.org/abs/${id}`,
    date: e.published ? e.published.slice(0, 10) : undefined,
  };
  if (e.journalRef) item.publicationTitle = e.journalRef;
  if (e.doi) item.DOI = bareDoi(e.doi);
  if (e.summary) {
    const ab = e.summary.replace(/\s+/g, ' ').trim();
    if (ab) item.abstractNote = ab.slice(0, ABSTRACT_MAX);
  }
  return item;
}

/**
 * Overlay a client-provided item spec (from by_identifier's optional `_spec`
 * or a by_url "save chosen item" spec) onto fetched defaults.
 *
 * Field priority, most to least:
 *   1. caller-provided field values (title, creators, date, DOI, url, extra…)
 *   2. fetch-provided defaults (arXiv feed / scholar record)
 * `itemType` follows the documented rule: an explicit non-generic type wins;
 * "preprint" is demoted to "journalArticle" when the fetched record shows a
 * published venue (the preprint-ness carries via extra/arXiv line); "generic"
 * with no other fields means "use the fetch default".
 */
export function foldSpec(spec: Record<string, unknown> | null | undefined, item: ResolvedItem, src: string): void {
  if (!spec) return;
  const {
    itemType,
    creators,
    title,
    date,
    year,
    DOI,
    url,
    extra,
    abstractNote,
    publicationTitle,
    venue,
    ...rest
  } = spec;

  if (typeof title === 'string' && title.trim()) item.title = title.trim();
  if (Array.isArray(creators) && creators.length) item.creators = creators as ResolvedItem['creators'];
  if (typeof date === 'string' && date.trim()) item.date = date.trim();
  else if (typeof year === 'number') item.date = String(year);
  if (typeof DOI === 'string') item.DOI = bareDoi(DOI) || undefined;
  if (typeof url === 'string' && url.trim()) item.url = url.trim();
  if (typeof extra === 'string' && extra.trim()) item.extra = [item.extra, extra.trim()].filter(Boolean).join('\n');
  if (typeof abstractNote === 'string' && abstractNote.trim()) item.abstractNote = abstractNote.trim();
  if (typeof publicationTitle === 'string' && publicationTitle.trim()) item.publicationTitle = publicationTitle.trim();
  if (typeof venue === 'string' && venue.trim()) item.publicationTitle = item.publicationTitle ?? venue.trim();

  // Item-type decision (documented above).
  if (typeof itemType === 'string' && itemType.trim() && itemType.trim() !== 'generic') {
    item.itemType = itemType.trim();
  } else if (Object.keys(rest).length) {
    // A partial generic spec still implies the caller cares about shape.
    item.itemType = 'generic';
  }
  if (item.itemType === 'preprint' && (item.publicationTitle || item.venue)) {
    item.itemType = 'journalArticle';
  }
  if (item.itemType !== 'journalArticle' && item.itemType !== 'thesis') {
    delete item.publicationTitle;
  }
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && v !== null) item[k] = v;
  }
  item.extra = [item.extra, `resolved:${src}`].filter(Boolean).join('\n');
}

/** Map an OpenAlex/Crossref scholar work to a draft Zotero item (DOI lookups). */
export function fromScholarWork(w: { title?: string; authors?: string[]; year?: number; venue?: string }, doi: string): ResolvedItem {
  const item: ResolvedItem = {
    itemType: w.venue ? 'journalArticle' : 'generic',
    title: w.title ?? `DOI ${bareDoi(doi)}`,
    creators: (w.authors ?? []).map((a) => ({ creatorType: 'author' as const, ...nameParts(a) })),
    date: w.year ? String(w.year) : undefined,
    DOI: bareDoi(doi),
    extra: 'source:scholar',
  };
  if (w.venue) item.publicationTitle = w.venue;
  return item;
}

/** Human style name -> CSL style id (the filename, without .csl). */
const ALIASES: Record<string, string> = {
  apa: 'apa',
  'apa 7th': 'apa',
  apa7: 'apa',
  'apa 6th': 'apa-6th-edition',
  ieee: 'ieee',
  vancouver: 'vancouver',
  chicago: 'chicago-note-bibliography',
  'chicago note': 'chicago-note-bibliography',
  'chicago author-date': 'chicago-author-date',
  mla: 'modern-language-association',
  'mla 9th': 'modern-language-association',
  nature: 'nature',
  science: 'science',
  harvard: 'harvard-cite-them-right',
  acm: 'association-for-computing-machinery',
  acs: 'american-chemical-society',
  ama: 'american-medical-association',
  apsa: 'american-political-science-association',
  cell: 'cell',
};

export const COMMON_STYLES = Object.keys(ALIASES);

const STYLE_BASE = 'https://raw.githubusercontent.com/citation-style-language/styles/master';
const LOCALE_BASE = 'https://raw.githubusercontent.com/citation-style-language/locales/master';

export interface StyleResolverOptions {
  fetchImpl?: typeof fetch;
  styleBase?: string;
  localeBase?: string;
}

/** Resolves human style names to CSL ids and fetches (and caches) CSL style + locale XML. */
export class StyleResolver {
  private styleCache = new Map<string, string>();
  private localeCache = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  private readonly styleBase: string;
  private readonly localeBase: string;

  constructor(opts: StyleResolverOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.styleBase = opts.styleBase ?? STYLE_BASE;
    this.localeBase = opts.localeBase ?? LOCALE_BASE;
  }

  resolveId(name: string): string {
    const key = name.trim().toLowerCase();
    return ALIASES[key] ?? name.trim();
  }

  async fetchStyle(id: string, depth = 0): Promise<string> {
    if (this.styleCache.has(id)) return this.styleCache.get(id)!;
    const res = await this.fetchImpl(`${this.styleBase}/${id}.csl`);
    if (!res.ok) throw new Error(`CSL style "${id}" not found (HTTP ${res.status}).`);
    let xml = await res.text();
    const parent = this.parentId(xml);
    if (parent && parent !== id && depth < 3) {
      xml = await this.fetchStyle(parent, depth + 1);
    }
    this.styleCache.set(id, xml);
    return xml;
  }

  async fetchLocale(lang = 'en-US'): Promise<string> {
    if (this.localeCache.has(lang)) return this.localeCache.get(lang)!;
    const res = await this.fetchImpl(`${this.localeBase}/locales-${lang}.xml`);
    if (!res.ok) {
      if (lang !== 'en-US') return this.fetchLocale('en-US');
      throw new Error(`CSL locale "${lang}" not found (HTTP ${res.status}).`);
    }
    const xml = await res.text();
    this.localeCache.set(lang, xml);
    return xml;
  }

  private parentId(xml: string): string | null {
    const link = xml.match(/<link[^>]*rel="independent-parent"[^>]*>/);
    if (!link) return null;
    const href = link[0].match(/href="([^"]+)"/);
    if (!href) return null;
    const id = href[1]!.match(/styles\/([^/"]+)$/);
    return id ? id[1]! : null;
  }
}

import CSL from 'citeproc';

export interface FormatOptions {
  items: any[];
  styleXml: string;
  localeXml: string;
  format?: 'html' | 'text' | 'rtf';
}

export interface FormatResult {
  bibliography: string;
  entries: string[];
}

/** Format a CSL-JSON item list into a bibliography using citeproc-js. */
export function formatBibliography(opts: FormatOptions): FormatResult {
  const byId: Record<string, any> = {};
  opts.items.forEach((it, i) => {
    const id = it.id ?? `ITEM-${i + 1}`;
    byId[id] = { ...it, id };
  });

  const sys = {
    retrieveLocale: (_lang: string) => opts.localeXml,
    retrieveItem: (id: string) => byId[id],
  };

  const engine = new CSL.Engine(sys, opts.styleXml);
  if (opts.format) engine.setOutputFormat(opts.format);
  engine.updateItems(Object.keys(byId));
  const result = engine.makeBibliography();
  const entries: string[] = result && Array.isArray(result[1]) ? result[1] : [];
  return { bibliography: entries.join('').trim(), entries };
}

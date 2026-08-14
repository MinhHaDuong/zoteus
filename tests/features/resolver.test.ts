import { describe, it, expect } from 'vitest';
import {
  setArxivMinGapMs,
  parseIdentifier,
  bareDoi,
  arxivItem,
  fromScholarWork,
  foldSpec,
} from '../../src/features/resolve/resolve.js';

describe('parseIdentifier', () => {
  it('classifies bare DOIs', () => {
    expect(parseIdentifier('10.1109/ICRA.2019.8794293')).toEqual({ type: 'doi', value: '10.1109/ICRA.2019.8794293' });
  });

  it('classifies DOI URLs with and without www/dx prefixes', () => {
    expect(parseIdentifier('https://doi.org/10.1234/abc')).toEqual({ type: 'doi', value: '10.1234/abc' });
    expect(parseIdentifier('https://dx.doi.org/10.1234/abc')).toEqual({ type: 'doi', value: '10.1234/abc' });
  });

  it('classifies arXiv new-style ids with and without /abs/ prefix', () => {
    expect(parseIdentifier('2201.00001')).toEqual({ type: 'arxiv', value: '2201.00001' });
    expect(parseIdentifier('https://arxiv.org/abs/2201.00001v2')).toEqual({ type: 'arxiv', value: '2201.00001v2' });
  });

  it('classifies arXiv legacy ids', () => {
    expect(parseIdentifier('math.GT/0309136')).toEqual({ type: 'arxiv', value: 'math.gt/0309136' });
  });

  it('classifies ISBNs', () => {
    expect(parseIdentifier('9783161484100')).toEqual({ type: 'isbn', value: '9783161484100' });
  });

  it('returns null for free text and unknown URLs', () => {
    expect(parseIdentifier('the role of metadata')).toBeNull();
    expect(parseIdentifier('https://example.com/page')).toBeNull();
    expect(parseIdentifier('')).toBeNull();
  });
});

describe('bareDoi', () => {
  it('strips URL prefixes', () => {
    expect(bareDoi('https://dx.doi.org/10.1/abc')).toBe('10.1/abc');
    expect(bareDoi('10.1/abc')).toBe('10.1/abc');
  });
});

describe('fromScholarWork', () => {
  it('maps a scholar work with a venue to a journalArticle', () => {
    const item = fromScholarWork(
      { title: 'A', authors: ['Ada Lovelace'], year: 2021, venue: 'Nature' },
      '10.1234/abc',
    );
    expect(item).toMatchObject({
      itemType: 'journalArticle',
      title: 'A',
      creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
      date: '2021',
      DOI: '10.1234/abc',
      publicationTitle: 'Nature',
    });
    expect(item.extra).toContain('source:scholar');
  });

  it('falls back to generic without a venue', () => {
    const item = fromScholarWork({ title: 'B', authors: [], year: 2020 }, '10.9/x');
    expect(item.itemType).toBe('generic');
  });
});

describe('foldSpec', () => {
  it('lets an explicit non-generic itemType win', () => {
    const item = { itemType: 'preprint', title: 'T', creators: [] as any[] };
    foldSpec({ itemType: 'report' }, item as any, 'test');
    expect(item.itemType).toBe('report');
  });

  it('demotes preprint to journalArticle when a venue is present', () => {
    const item = { itemType: 'preprint', title: 'T', creators: [] as any[], publicationTitle: 'JACM' };
    foldSpec({}, item as any, 'test');
    expect(item.itemType).toBe('journalArticle');
  });

  it('keeps generic with no extra fields -> fetch default', () => {
    const item = { itemType: 'preprint', title: 'T', creators: [] as any[] };
    foldSpec({ itemType: 'generic' }, item as any, 'test');
    expect(item.itemType).toBe('preprint');
  });

  it('adds resolved: source and merges extra', () => {
    const item = { itemType: 'preprint', title: 'T', creators: [] as any[], extra: 'arXiv:2201.00001' };
    foldSpec({ extra: 'note' }, item as any, 'arxiv');
    expect(item.extra).toContain('arXiv:2201.00001');
    expect(item.extra).toContain('note');
    expect(item.extra).toContain('resolved:arxiv');
  });
});

describe('arxivItem', () => {
  // No polite-pacing waits in unit tests (production keeps the 3s gap).
  setArxivMinGapMs(0);

  const entryXml = (id: string, title: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>http://arxiv.org/abs/${id}</id>
      <published>2022-01-01T00:00:00Z</published>
      <title>${title}</title>
      <summary>None.</summary>
      <author><name>Only Author</name></author>
    </entry></feed>`;

  it('parses the Atom feed into a preprint', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2201.00001v2</id>
    <updated>2022-01-02T00:00:00Z</updated>
    <published>2022-01-01T00:00:00Z</published>
    <title>A Test &amp; Paper</title>
    <summary>A short abstract.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Charles Babbage</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1234/arxiv.1</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">J. ACM</arxiv:journal_ref>
  </entry>
</feed>`;
    const fetcher = async () => new Response(xml, { status: 200 });
    const item = await arxivItem('2201.00001', fetcher as any);
    expect(item).toMatchObject({
      itemType: 'journalArticle', // journal_ref present
      title: 'A Test & Paper',
      creators: [
        { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
        { creatorType: 'author', firstName: 'Charles', lastName: 'Babbage' },
      ],
      DOI: '10.1234/arxiv.1',
      publicationTitle: 'J. ACM',
      date: '2022-01-01',
    });
    expect(item!.extra).toContain('arXiv:2201.00001');
    expect(item!.abstractNote).toBe('A short abstract.');
  });

  it('types as preprint without a journal_ref', async () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>http://arxiv.org/abs/2201.00002</id>
      <published>2022-01-01T00:00:00Z</published>
      <title>No Journal</title>
      <summary>None.</summary>
      <author><name>Only Author</name></author>
    </entry></feed>`;
    const fetcher = async () => new Response(xml, { status: 200 });
    const item = await arxivItem('2201.00002', fetcher as any);
    expect(item?.itemType).toBe('preprint');
    expect(item?.publicationTitle).toBeUndefined();
  });

  it('returns null on HTTP error', async () => {
    const fetcher = async () => new Response('nope', { status: 500 });
    expect(await arxivItem('2201.00003', fetcher as any)).toBeNull();
  });

  it('backs off and succeeds when arXiv throttles once (429 then 200)', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
      return new Response(entryXml('2201.00004', 'Throttled Then Fine'), { status: 200 });
    };
    const item = await arxivItem('2201.00004', fetcher as any);
    expect(calls).toBe(2);
    expect(item?.title).toBe('Throttled Then Fine');
  });

  it('throws a rate-limit error instead of reporting "no record" when throttling persists', async () => {
    const fetcher = async () => new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
    await expect(arxivItem('2201.00005', fetcher as any)).rejects.toThrow(/rate-limiting/i);
  });
});

import { describe, it, expect } from 'vitest';
import { repairItemData, repairItems, itemsArraySchema, itemPatchSchema } from '../../src/schema/item-payload.js';

describe('repairItemData', () => {
  it('unwraps a self-named itemType wrapper object', () => {
    const r = repairItemData({ itemType: { itemType: 'report' } });
    expect(r.itemType).toBe('report');
  });

  it('clears a non-string itemType wrapper so validation can name it', () => {
    const r = repairItemData({ itemType: {} });
    expect(r.itemType).toBeUndefined();
  });

  it('unwraps scalar wedding-cake fields', () => {
    const r = repairItemData({
      itemType: { itemType: 'journalArticle' },
      title: { title: 'Deep Learning' },
      date: { date: '2021' },
    });
    expect(r).toEqual({ itemType: 'journalArticle', title: 'Deep Learning', date: '2021' });
  });

  it('unwraps creator/tag objects inside arrays', () => {
    const r = repairItemData({
      itemType: 'journalArticle',
      creators: [{ creatorType: { creatorType: 'author' }, name: { name: 'Ada' } }],
      tags: [{ tag: { tag: 'ml' } }],
    });
    expect(r.creators).toEqual([{ creatorType: 'author', name: 'Ada' }]);
    expect(r.tags).toEqual([{ tag: 'ml' }]);
  });

  it('leaves legitimate nested objects (e.g. multi-key specs) intact', () => {
    const r = repairItemData({ itemType: 'journalArticle', extra: { a: 1, b: 2 } });
    expect(r.extra).toEqual({ a: 1, b: 2 });
  });

  it('leaves a plain item untouched', () => {
    const plain = { itemType: 'book', title: 'T', tags: [{ tag: 'x' }] };
    expect(repairItemData(plain)).toEqual(plain);
  });

  it('unwraps collections elements that are themselves {"collections": "KEY"}', () => {
    const r = repairItemData({
      itemType: 'journalArticle',
      title: 'T',
      collections: [{ collections: 'XRD8KHBV' }],
    });
    expect(r.collections).toEqual(['XRD8KHBV']);
  });

  it('wraps a bare collections key into an array', () => {
    const r = repairItemData({ itemType: 'journalArticle', collections: 'XRD8KHBV' });
    expect(r.collections).toEqual(['XRD8KHBV']);
  });

  it('keeps relations as a real object', () => {
    const r = repairItemData({
      itemType: 'journalArticle',
      relations: { 'dc:relation': 'http://zotero.org/users/1/items/X' },
    });
    expect(r.relations).toEqual({ 'dc:relation': 'http://zotero.org/users/1/items/X' });
  });

  it('repairs the exact transcript wedding-cake payload', () => {
    const r = repairItemData({
      itemType: { itemType: 'report' },
      title: { title: 'Dyna-2: A 1-Million-Hour Scaling Law for World-Action Models' },
      date: { date: '2026-08' },
      institution: { institution: 'Dyna Robotics' },
      reportType: { reportType: 'Technical report' },
      url: { url: 'https://www.dyna.co/dyna-2' },
      creators: [{ creatorType: { creatorType: 'author' }, name: { name: 'Dyna Robotics' } }],
      collections: [{ collections: 'XRD8KHBV' }],
    });
    expect(r).toEqual({
      itemType: 'report',
      title: 'Dyna-2: A 1-Million-Hour Scaling Law for World-Action Models',
      date: '2026-08',
      institution: 'Dyna Robotics',
      reportType: 'Technical report',
      url: 'https://www.dyna.co/dyna-2',
      creators: [{ creatorType: 'author', name: 'Dyna Robotics' }],
      collections: ['XRD8KHBV'],
    });
  });

  it('repairs Quote-suffixed field names (the creatorsQuote/collectionsQuote transcript shape)', () => {
    const r = repairItemData({
      itemType: { itemType: 'report' },
      title: { title: 'Dyna-2: A 1-Million-Hour Scaling Law for World-Action Models' },
      creatorsQuote: { creators: [{ creatorType: { creatorType: 'author' }, name: { name: 'Dyna Robotics' } }] },
      collectionsQuote: { collections: ['XRD8KHBV'] },
    });
    expect(r).toEqual({
      itemType: 'report',
      title: 'Dyna-2: A 1-Million-Hour Scaling Law for World-Action Models',
      creators: [{ creatorType: 'author', name: 'Dyna Robotics' }],
      collections: ['XRD8KHBV'],
    });
    expect(r).not.toHaveProperty('creatorsQuote');
    expect(r).not.toHaveProperty('collectionsQuote');
  });

  it('does not clobber a real field when both spellings are present', () => {
    const r = repairItemData({
      itemType: 'report',
      collections: ['ABCD1234'],
      collectionsQuote: { collections: ['XRD8KHBV'] },
    });
    expect(r.collections).toEqual(['ABCD1234']);
    expect(r.collectionsQuote).toEqual({ collections: ['XRD8KHBV'] });
  });

  it('repairs singular collection/collectionQuote spellings', () => {
    const r = repairItemData({
      itemType: { itemType: 'report' },
      collectionQuote: { collection: 'XRD8KHBV' },
    });
    expect(r.collections).toEqual(['XRD8KHBV']);
  });
});

describe('repairItems / itemsArraySchema', () => {
  it('repairs every element of an items array', () => {
    const repaired = repairItems([
      { itemType: { itemType: 'report' }, title: { title: 'Dyna-2' } },
      { itemType: 'book', title: 'T' },
    ]);
    expect(repaired[0]).toEqual({ itemType: 'report', title: 'Dyna-2' });
    expect(repaired[1]).toEqual({ itemType: 'book', title: 'T' });
  });

  it('parses a JSON-encoded items string', async () => {
    const parsed = itemsArraySchema.parse('[{"itemType": "report", "title": "Dyna"}]');
    expect(parsed).toEqual([{ itemType: 'report', title: 'Dyna' }]);
  });

  it('coerces a single object into an array', async () => {
    const parsed = itemsArraySchema.parse({ itemType: 'report', title: 'Dyna' });
    expect(parsed).toEqual([{ itemType: 'report', title: 'Dyna' }]);
  });

  it('unwraps wedding-cake items end-to-end through the schema', async () => {
    const parsed = itemsArraySchema.parse([
      { itemType: { itemType: 'report' }, title: { title: 'Dyna-2' }, institution: { institution: 'Dyna Robotics' } },
    ]);
    expect(parsed).toEqual([{ itemType: 'report', title: 'Dyna-2', institution: 'Dyna Robotics' }]);
  });
});

describe('itemPatchSchema', () => {
  it('repairs wedding-cake patches', async () => {
    const parsed = itemPatchSchema.parse({ title: { title: 'New' }, date: { date: '2024' } });
    expect(parsed).toEqual({ title: 'New', date: '2024' });
  });
});

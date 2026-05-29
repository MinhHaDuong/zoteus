import { describe, it, expect } from 'vitest';
import { validateItem } from '../../src/schema/validate.js';
import type { ZoteroSchema } from '../../src/schema/schema-service.js';

const schema: ZoteroSchema = {
  version: 1,
  itemTypes: [
    {
      itemType: 'journalArticle',
      fields: [{ field: 'title' }, { field: 'publicationTitle' }, { field: 'date' }],
      creatorTypes: [{ creatorType: 'author', primary: true }, { creatorType: 'editor' }],
    },
    { itemType: 'note' },
  ],
};

describe('validateItem', () => {
  it('rejects a missing itemType', () => {
    expect(validateItem(schema, {}).valid).toBe(false);
  });

  it('rejects an unknown itemType', () => {
    const r = validateItem(schema, { itemType: 'spaceship' });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/Unknown itemType/);
  });

  it('rejects an unknown field for the type', () => {
    const r = validateItem(schema, { itemType: 'journalArticle', title: 'X', warpDrive: true });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /warpDrive/.test(e))).toBe(true);
  });

  it('rejects an invalid creator type', () => {
    const r = validateItem(schema, {
      itemType: 'journalArticle',
      title: 'X',
      creators: [{ creatorType: 'wizard', lastName: 'Y' }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /wizard/.test(e))).toBe(true);
  });

  it('accepts a valid journalArticle', () => {
    const r = validateItem(schema, {
      itemType: 'journalArticle',
      title: 'Deep Learning',
      date: '2021',
      creators: [{ creatorType: 'author', lastName: 'Hinton' }],
      tags: [{ tag: 'ml' }],
      collections: ['ABC'],
    });
    expect(r.valid).toBe(true);
  });

  it('passes special types (note) regardless of fields', () => {
    expect(validateItem(schema, { itemType: 'note', note: '<p>hi</p>' }).valid).toBe(true);
  });
});

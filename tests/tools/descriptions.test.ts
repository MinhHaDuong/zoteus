import { describe, it, expect } from 'vitest';
import semanticSearch from '../../src/tools/semantic-search.js';
import searchItems from '../../src/tools/search-items.js';
import bibliography from '../../src/tools/bibliography.js';
import formatBib from '../../src/tools/format-bibliography.js';

describe('tool descriptions disambiguate overlapping pairs', () => {
  it('semantic_search points to search_items for exact filters', () => {
    expect(semanticSearch.description).toMatch(/zotero_search_items/);
    expect(semanticSearch.description.toLowerCase()).toMatch(/conceptual|meaning|papers about/);
  });
  it('search_items points to semantic_search for conceptual queries', () => {
    expect(searchItems.description).toMatch(/zotero_semantic_search/);
  });
  it('bibliography points to format_bibliography and notes server-side/in-library', () => {
    expect(bibliography.description).toMatch(/zotero_format_bibliography/);
    expect(bibliography.description.toLowerCase()).toMatch(/server-side|in the library|already in/);
  });
  it('format_bibliography points to bibliography and notes citeproc/arbitrary CSL', () => {
    expect(formatBib.description).toMatch(/zotero_bibliography/);
    expect(formatBib.description.toLowerCase()).toMatch(/citeproc|arbitrary|any csl/);
  });
});

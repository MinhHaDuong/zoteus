import { describe, it, expect } from 'vitest';
import semanticSearch from '../../src/tools/semantic-search.js';
import searchItems from '../../src/tools/search-items.js';
import fulltext from '../../src/tools/fulltext.js';
import bibliography from '../../src/tools/bibliography.js';
import formatBib from '../../src/tools/format-bibliography.js';
import scholar from '../../src/tools/scholar.js';
import indexTool from '../../src/tools/index-tool.js';

describe('tool descriptions disambiguate overlapping pairs', () => {
  it('semantic_search points to search_items for exact filters', () => {
    expect(semanticSearch.description).toMatch(/zotero_search_items/);
    expect(semanticSearch.description.toLowerCase()).toMatch(/conceptual|meaning|papers about/);
  });
  it('search_items points to semantic_search for conceptual queries', () => {
    expect(searchItems.description).toMatch(/zotero_semantic_search/);
  });
  it('search_items documents the empty-result auto-retry into full text', () => {
    expect(searchItems.description.toLowerCase()).toMatch(/auto-retr|retries|retry/);
  });
  it('fulltext disclaims being a search and points to search_items', () => {
    expect(fulltext.description).toMatch(/zotero_search_items/);
    expect(fulltext.description.toLowerCase()).toMatch(/not a search/);
  });
  it('bibliography points to format_bibliography and notes server-side/in-library', () => {
    expect(bibliography.description).toMatch(/zotero_format_bibliography/);
    expect(bibliography.description.toLowerCase()).toMatch(/server-side|in the library|already in/);
  });
  it('format_bibliography points to bibliography and notes citeproc/arbitrary CSL', () => {
    expect(formatBib.description).toMatch(/zotero_bibliography/);
    expect(formatBib.description.toLowerCase()).toMatch(/citeproc|arbitrary|any csl/);
  });
  it('scholar disclaims being a library search and steers to the library tools', () => {
    // Regression: the client previously mistook zotero_scholar for a library-search
    // tool (it even scans the library for inLibrary flags), producing sessions that
    // "searched the library" via OpenAlex with no library items ever returned.
    expect(scholar.description.toLowerCase()).toMatch(/does not search|not search.*library|external/);
    expect(scholar.description).toMatch(/zotero_search_items/);
    expect(scholar.description).toMatch(/zotero_semantic_search/);
    expect(scholar.inputSchema.include_in_library?.description).toMatch(/default false/);
  });
  it('index build output points to semantic_search as the next step', () => {
    expect(indexTool.description).toMatch(/zotero_semantic_search/);
  });
});

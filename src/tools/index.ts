import type { ToolDefinition } from '../registry/registry.js';
import whoami from './whoami.js';
import searchItems from './search-items.js';
import getItem from './get-item.js';
import schemaTool from './schema.js';
import createItems from './create-items.js';
import updateItem from './update-item.js';
import trashItems from './trash-items.js';
import deleteItems from './delete-items.js';
import manageCollections from './manage-collections.js';
import manageTags from './manage-tags.js';
import savedSearches from './saved-searches.js';
import groups from './groups.js';
import exportTool from './export.js';
import fulltext from './fulltext.js';
import sync from './sync.js';
import attachment from './attachment.js';
import importTool from './import.js';
import styles from './styles.js';
import formatBibliography from './format-bibliography.js';
import bibliography from './bibliography.js';
import indexTool from './index-tool.js';
import semanticSearch from './semantic-search.js';

export const tools: ToolDefinition[] = [
  // Read
  whoami,
  searchItems,
  getItem,
  schemaTool,
  // Write (M3)
  createItems,
  updateItem,
  trashItems,
  deleteItems,
  manageCollections,
  manageTags,
  savedSearches,
  // Files / sync / groups / export (M4)
  groups,
  exportTool,
  fulltext,
  sync,
  attachment,
  // Citation pipeline (M5)
  importTool,
  styles,
  formatBibliography,
  bibliography,
  // Hybrid semantic search (M6)
  indexTool,
  semanticSearch,
];

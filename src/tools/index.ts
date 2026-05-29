import type { ToolDefinition } from '../registry/registry.js';
import whoami from './whoami.js';
import searchItems from './search-items.js';
import getItem from './get-item.js';
import schemaTool from './schema.js';

export const tools: ToolDefinition[] = [whoami, searchItems, getItem, schemaTool];

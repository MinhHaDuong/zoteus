import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const searchTools: ToolDefinition = {
  name: 'search_tools',
  title: 'Discover Zotero tools',
  description:
    'Discover the available Zotero tools by keyword — useful for progressive disclosure when you do not want to load every tool definition up front (the code-execution-with-MCP pattern). Pass an optional `query` (matched against tool names, titles, and descriptions) and `detail` ("names" or "descriptions", default "descriptions"). Returns the matching `zotero_*` tools so you can pick the right one for a task. With no query, returns the full catalog.',
  inputSchema: {
    query: z.string().optional().describe('Keyword to match against tool names/titles/descriptions.'),
    detail: z.enum(['names', 'descriptions']).optional().describe('How much to return (default "descriptions").'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    const catalog = ctx.toolCatalog ?? [];
    const q = (args.query ?? '').toLowerCase().trim();
    const matched = q
      ? catalog.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.title.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q),
        )
      : catalog;
    const detail = args.detail ?? 'descriptions';
    const tools = matched.map((t) =>
      detail === 'names' ? { name: t.name } : { name: t.name, title: t.title, description: t.description.slice(0, 220) },
    );
    return ok({ tools, count: tools.length }, `${tools.length} tool(s) match${q ? ` "${args.query}"` : ' (full catalog)'}.`);
  },
};

export default searchTools;

#!/usr/bin/env node
// Manual smoke test: spawn the built server over real stdio and exercise it.
// Usage: set -a && . ./.env && set +a && node scripts/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env },
});
const client = new Client({ name: 'zoteus-smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).sort().join(', '));

const who = await client.callTool({ name: 'zotero_whoami', arguments: {} });
console.log('whoami:', who.content?.[0]?.text);

const search = await client.callTool({
  name: 'zotero_search_items',
  arguments: { limit: 3, top: true },
});
console.log('search:', search.content?.[0]?.text);
const items = search.structuredContent?.items ?? [];
for (const it of items) console.log('   -', it.itemType, '·', it.title, it.date ? `(${it.date})` : '');

const schema = await client.callTool({ name: 'zotero_schema', arguments: {} });
console.log('schema:', schema.content?.[0]?.text);

await client.close();
const okWho = typeof who.content?.[0]?.text === 'string';
const okTools = tools.length >= 20 && tools.some((t) => t.name === 'zotero_search_items');
if (!okWho || !okTools) {
  console.error('SMOKE FAILED');
  process.exit(1);
}
console.log('SMOKE OK');

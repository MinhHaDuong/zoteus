#!/usr/bin/env node
// Drive the built server over stdio like a real MCP client (what VS Code does),
// and print the tool list plus the scholar description + index-build output —
// the parts changed by the discoverability fix.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, ZOTEUS_LOCAL: 'off' },
});
const client = new Client({ name: 'zoteus-check', version: '0.0.0' });
await client.connect(transport);

const res = await client.listTools();
const tools = res.tools.map((t) => t.name).sort();
console.log(`TOOLS (${tools.length}):`);
console.log(tools.join(', '));

const scholar = res.tools.find((t) => t.name === 'zotero_scholar');
console.log('\n--- zotero_scholar description (fixed) ---');
console.log(scholar.description);
console.log('\n--- zotero_scholar include_in_library param ---');
console.log(JSON.stringify(scholar.inputSchema?.properties?.include_in_library ?? null));

// Exercise the index build path against an empty library (no live Zotero here),
// just to prove the tool runs and its summary points at semantic search.
const idx = await client.callTool({ name: 'zotero_index', arguments: { action: 'status' } });
console.log('\n--- zotero_index status ---');
console.log(idx.content?.[0]?.text);

// Scholar lookup should fail cleanly (no network in this sandbox or no record),
// and crucially must NOT hit the library router (no inLibrary scan by default).
const sch = await client.callTool({
  name: 'zotero_scholar',
  arguments: { action: 'lookup', doi: '10.1109/ICRA.2019.8794293' },
});
console.log('\n--- zotero_scholar lookup (no key / no library) ---');
console.log(sch.isError ? `isError: ${sch.isError}` : 'ok');
console.log((sch.content?.[0]?.text ?? '').slice(0, 300));

await client.close();
console.log('\nCHECK DONE');

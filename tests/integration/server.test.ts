import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools, type ToolContext } from '../../src/registry/registry.js';
import { registerResources } from '../../src/resources/index.js';
import { tools } from '../../src/tools/index.js';

function fakeCtx(): ToolContext {
  const cloud = { userID: 19552201, username: 'oscardvs', access: { user: { write: true } } };
  return {
    config: { local: 'off', libraryType: 'user' } as any,
    capabilities: { cloud: cloud as any, localApi: false },
    router: {
      whoami: () => cloud,
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      searchItems: vi.fn(async () => ({
        data: [
          {
            key: 'ABCD1234',
            version: 2114,
            data: {
              itemType: 'journalArticle',
              title: 'Deep Learning',
              date: '2021',
              creators: [{ creatorType: 'author', lastName: 'Hinton' }],
            },
          },
        ],
        totalResults: 1,
        lastModifiedVersion: 2114,
      })),
      getItem: vi.fn(async () => ({ key: 'ABCD1234', data: { itemType: 'journalArticle', title: 'Deep Learning' } })),
      getItemChildren: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })),
      listCollections: vi.fn(async () => ({
        data: [{ key: 'COLL', data: { name: 'Reading' } }],
        totalResults: 1,
        lastModifiedVersion: 1,
      })),
    } as any,
    schema: {
      getSchema: vi.fn(async () => ({ version: 39, itemTypes: [{ itemType: 'book', fields: [{ field: 'title' }] }] })),
      itemTypeNames: vi.fn(async () => ['book']),
    } as any,
    web: {} as any,
    styles: { resolveId: (n: string) => n, fetchStyle: async () => '', fetchLocale: async () => '' } as any,
    translation: { isUp: async () => false } as any,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

async function connect() {
  const server = new McpServer(
    { name: 'zoteus-test', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  const ctx = fakeCtx();
  registerAllTools(server, tools, ctx);
  registerResources(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, ctx };
}

describe('Zoteus server (in-process)', () => {
  it('lists all twenty tools', async () => {
    const { client } = await connect();
    const { tools: listed } = await client.listTools();
    const names = listed.map((t) => t.name).sort();
    expect(names).toEqual([
      'zotero_attachment',
      'zotero_bibliography',
      'zotero_create_items',
      'zotero_delete_items',
      'zotero_export',
      'zotero_format_bibliography',
      'zotero_fulltext',
      'zotero_get_item',
      'zotero_groups',
      'zotero_import',
      'zotero_manage_collections',
      'zotero_manage_tags',
      'zotero_saved_searches',
      'zotero_schema',
      'zotero_search_items',
      'zotero_styles',
      'zotero_sync',
      'zotero_trash_items',
      'zotero_update_item',
      'zotero_whoami',
    ]);
  });

  it('calls zotero_search_items and returns structured content', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_search_items',
      arguments: { q: 'deep learning' },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.items[0].title).toBe('Deep Learning');
    expect(res.content[0].text).toMatch(/Found 1 item/);
  });

  it('calls zotero_whoami', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({ name: 'zotero_whoami', arguments: {} });
    expect(res.structuredContent.userID).toBe(19552201);
  });

  it('reads the zotero://collections resource', async () => {
    const { client } = await connect();
    const res: any = await client.readResource({ uri: 'zotero://collections' });
    const data = JSON.parse(res.contents[0].text);
    expect(data[0].data.name).toBe('Reading');
  });
});

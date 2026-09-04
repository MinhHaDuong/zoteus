import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools, type ToolContext } from '../../src/registry/registry.js';
import { tools } from '../../src/tools/index.js';

// Issue #1: array-valued fields (creators, tags, collections) inside a generic
// patch/item object must reach the Zotero API as true JSON arrays.

const CREATORS = [{ creatorType: 'author', firstName: 'John', lastName: 'Doe' }];
const TAGS = [{ tag: 'reviewed' }];

function fakeCtx() {
  const cloud = { userID: 1, username: 'u', access: { user: { write: true } } };
  const web = {
    getItem: vi.fn(async () => ({
      key: 'ABCD1234',
      version: 7,
      data: { version: 7, itemType: 'book', title: 'Old', creators: [] },
    })),
    // Typed args, not `async () => 8`: without them vi.fn infers a zero-length tuple for
    // mock.calls, and every `mock.calls[0][2]` assertion below is a compile error.
    patchItem: vi.fn(async (..._args: any[]) => 8),
    writeItems: vi.fn(async (_lib: any, objects: any[]) => ({
      successful: objects.map((o, i) => ({ index: i, key: `KEY${i}`, version: 9, data: o })),
      unchanged: [],
      failed: [],
      newLibraryVersion: 9,
    })),
    currentLibraryVersion: vi.fn(async () => 7),
  };
  const ctx: ToolContext = {
    config: { local: 'off', libraryType: 'user' } as any,
    remoteCaller: false,
    capabilities: { cloud: cloud as any, localApi: false, localGroupIds: [] },
    router: { whoami: () => cloud, defaultLibrary: () => ({ type: 'user', id: 1 }) } as any,
    schema: {
      getSchema: vi.fn(async () => ({ version: 39, itemTypes: [] })),
      itemTypeNames: vi.fn(async () => ['book']),
      validateItem: vi.fn(async () => ({ valid: true, errors: [] })),
      templateFor: vi.fn(async () => ({ itemType: 'book', title: '', creators: [], tags: [] })),
    } as any,
    web: web as any,
    local: undefined,
    styles: {} as any,
    translation: { isUp: async () => false } as any,
    search: {} as any,
    scholar: {} as any,
    fetcher: {} as any,
    reopenSearchIndex: async () => ({}) as any,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    searchIndexPath: '/tmp/unused-index.json',
  };
  return { ctx, web };
}

async function connect() {
  const server = new McpServer(
    { name: 'zoteus-test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  const { ctx, web } = fakeCtx();
  registerAllTools(server, tools, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, web };
}

describe('array-valued fields survive the MCP pipeline (issue #1)', () => {
  it('update_item: creators/tags arrays in patch reach patchItem as real arrays', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: {
        item_key: 'ABCD1234',
        patch: { creators: CREATORS, tags: TAGS, title: 'New' },
      },
    });
    expect(res.isError).toBeFalsy();
    expect(web.patchItem).toHaveBeenCalledTimes(1);
    const sent = web.patchItem.mock.calls[0][2];
    expect(Array.isArray(sent.creators)).toBe(true);
    expect(sent.creators).toEqual(CREATORS);
    expect(Array.isArray(sent.tags)).toBe(true);
    expect(sent.tags).toEqual(TAGS);
    expect(sent.title).toBe('New');
  });

  it('update_item dry_run reports the same array values', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: {
        item_key: 'ABCD1234',
        patch: { creators: CREATORS },
        dry_run: true,
      },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.diff.creators.after).toEqual(CREATORS);
  });

  it('create_items: creators/tags arrays inside items reach writeItems as real arrays', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_create_items',
      arguments: {
        items: [{ itemType: 'book', title: 'T', creators: CREATORS, tags: TAGS }],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(web.writeItems).toHaveBeenCalledTimes(1);
    const objects = web.writeItems.mock.calls[0][1];
    expect(Array.isArray(objects[0].creators)).toBe(true);
    expect(objects[0].creators).toEqual(CREATORS);
    expect(Array.isArray(objects[0].tags)).toBe(true);
    expect(objects[0].tags).toEqual(TAGS);
  });
});

// Clients working from the loosely-typed schema degrade array values in known
// ways: JSON-encoded strings, a single un-wrapped object, numeric-keyed
// objects, or a wrapper object around the real array. The tool boundary must
// repair these instead of forwarding them to Zotero (which 400s).
describe('degraded client shapes are repaired at the tool boundary (issue #1)', () => {
  it('patch.creators as a JSON-encoded string is parsed to a real array', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: { item_key: 'ABCD1234', patch: { creators: JSON.stringify(CREATORS) } },
    });
    expect(res.isError).toBeFalsy();
    expect(web.patchItem.mock.calls[0][2].creators).toEqual(CREATORS);
  });

  it('patch.creators as a single object is wrapped into an array', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: { item_key: 'ABCD1234', patch: { creators: CREATORS[0] } },
    });
    expect(res.isError).toBeFalsy();
    expect(web.patchItem.mock.calls[0][2].creators).toEqual(CREATORS);
  });

  it('patch.creators as a numeric-keyed object is converted to an array', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: { item_key: 'ABCD1234', patch: { creators: { 0: CREATORS[0] } } },
    });
    expect(res.isError).toBeFalsy();
    expect(web.patchItem.mock.calls[0][2].creators).toEqual(CREATORS);
  });

  it('patch.creators as a single-key wrapper around the array is unwrapped', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: { item_key: 'ABCD1234', patch: { creators: { item: CREATORS } } },
    });
    expect(res.isError).toBeFalsy();
    expect(web.patchItem.mock.calls[0][2].creators).toEqual(CREATORS);
  });

  it('patch.collections as a bare collection key is wrapped into an array', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: { item_key: 'ABCD1234', patch: { collections: 'COLLKEY1' } },
    });
    expect(res.isError).toBeFalsy();
    expect(web.patchItem.mock.calls[0][2].collections).toEqual(['COLLKEY1']);
  });

  it('patch.relations as a JSON-encoded string is parsed to an object', async () => {
    const { client, web } = await connect();
    const relations = { 'dc:relation': 'http://zotero.org/users/1/items/XYZ' };
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: { item_key: 'ABCD1234', patch: { relations: JSON.stringify(relations) } },
    });
    expect(res.isError).toBeFalsy();
    expect(web.patchItem.mock.calls[0][2].relations).toEqual(relations);
  });

  it('ordinary string fields are never touched, even JSON-looking ones', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_update_item',
      arguments: {
        item_key: 'ABCD1234',
        patch: { title: '[Draft] {untitled}', extra: '[{"not":"parsed"}]' },
      },
    });
    expect(res.isError).toBeFalsy();
    const sent = web.patchItem.mock.calls[0][2];
    expect(sent.title).toBe('[Draft] {untitled}');
    expect(sent.extra).toBe('[{"not":"parsed"}]');
  });

  it('create_items: degraded creators/tags inside items are repaired', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_create_items',
      arguments: {
        items: [
          {
            itemType: 'book',
            title: 'T',
            creators: JSON.stringify(CREATORS),
            tags: TAGS[0],
          },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const objects = web.writeItems.mock.calls[0][1];
    expect(objects[0].creators).toEqual(CREATORS);
    expect(objects[0].tags).toEqual(TAGS);
  });

  it('create_items: items itself sent as a JSON-encoded string is repaired', async () => {
    const { client, web } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_create_items',
      arguments: {
        items: JSON.stringify([{ itemType: 'book', title: 'T', creators: CREATORS }]),
      },
    });
    expect(res.isError).toBeFalsy();
    const objects = web.writeItems.mock.calls[0][1];
    expect(objects[0].creators).toEqual(CREATORS);
  });
});

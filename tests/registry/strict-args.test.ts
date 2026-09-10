import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools, type ToolContext, type ToolDefinition } from '../../src/registry/registry.js';
import { closedArgumentSchema } from '../../src/registry/strict-args.js';
import { tools } from '../../src/tools/index.js';

/** A value the field would accept, so a whole-tool parse fails on nothing but strictness. */
function sample(schema: any, depth = 0): unknown {
  if (depth > 5) return undefined;
  const def = schema?._def;
  switch (def?.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return sample(def.innerType, depth + 1);
    case 'ZodEffects':
      return sample(def.schema, depth + 1);
    case 'ZodString':
      return 'x';
    case 'ZodNumber':
      return 1;
    case 'ZodBoolean':
      return true;
    case 'ZodEnum':
      return def.values[0];
    case 'ZodLiteral':
      return def.value;
    case 'ZodArray':
      return [sample(def.type, depth + 1)];
    case 'ZodUnion':
      return sample(def.options[0], depth + 1);
    case 'ZodRecord':
      return {};
    case 'ZodAny':
    case 'ZodUnknown':
      return 'x';
    case 'ZodObject': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(def.shape() as Record<string, unknown>)) {
        out[k] = sample(v, depth + 1);
      }
      return out;
    }
    default:
      return undefined;
  }
}

function issuesFor(shape: z.ZodRawShape, args: Record<string, unknown>): z.ZodIssue[] {
  const closed = closedArgumentSchema(shape);
  // A tool that declares no arguments comes back as the raw shape it went in as, still open.
  if (!(closed instanceof z.ZodType)) return [];
  const parsed = closed.safeParse(args);
  return parsed.success ? [] : parsed.error.issues;
}

function unknownKeyMessage(shape: z.ZodRawShape, args: Record<string, unknown>): string {
  const issue = issuesFor(shape, args).find((i) => i.code === 'unrecognized_keys');
  return issue?.message ?? '';
}

describe('closedArgumentSchema', () => {
  it('names the argument the caller meant, when only its spelling was wrong', () => {
    const shape = { q: z.string().optional(), limit: z.number().optional() };
    expect(unknownKeyMessage(shape, { query: 'kalman' })).toContain(
      'unknown argument `query`: this tool spells it `q`.',
    );
    expect(unknownKeyMessage(shape, { query: 'kalman' })).toContain('Nothing ran, because');
  });

  it('lists the arguments when the key resembles none of them', () => {
    const shape = { q: z.string().optional(), limit: z.number().optional() };
    expect(unknownKeyMessage(shape, { filter: 'core' })).toBe(
      'unknown argument `filter`. The arguments are: q, limit. ' +
        'Nothing ran, because the value you sent would have been dropped and the call would have ' +
        'answered a different question.',
    );
  });

  it('lists the arguments when the key resembles two of them at once', () => {
    const shape = {
      include: z.string().optional(),
      include_children: z.boolean().optional(),
    };
    // `include_child` truncates one and extends the other; guessing would be worse.
    expect(unknownKeyMessage(shape, { include_child: true })).toContain('The arguments are:');
  });

  it('points a hoisted key back into the object it belongs to', () => {
    const shape = {
      scope: z.object({ collection_keys: z.array(z.string()).optional() }).optional(),
      limit: z.number().optional(),
    };
    expect(unknownKeyMessage(shape, { collection_keys: ['ABCD1234'] })).toContain(
      'this tool takes it inside `scope`, as `scope.collection_keys`',
    );
  });

  it('sees through the preprocess wrapper the nested fixes use, and through arrays', () => {
    const inner = z.preprocess((v) => v, z.object({ text: z.string(), page_label: z.string().optional() }));
    const shape = { annotations: z.array(inner).optional() };
    expect(unknownKeyMessage(shape, { page_label: '7' })).toContain(
      'this tool takes it inside `annotations`, as `annotations[].page_label`',
    );
  });

  it('says where protocol bookkeeping belongs instead of listing Zotero fields', () => {
    const shape = { q: z.string().optional() };
    expect(unknownKeyMessage(shape, { _meta: { progressToken: 1 } })).toContain(
      "protocol metadata belongs on the request's `params._meta`",
    );
  });

  it('names every unknown argument, not just the first', () => {
    const shape = { q: z.string().optional() };
    const message = unknownKeyMessage(shape, { query: 'a', filter: 'b' });
    expect(message).toContain('`query`');
    expect(message).toContain('`filter`');
  });

  it('leaves a tool that declares no arguments exactly as it was', () => {
    const shape = {};
    // Returned unchanged: zotero_whoami and zotero_groups advertise an open object, have one
    // answer each, and would otherwise start refusing `zotero_groups {library_type:"group"}`.
    expect(closedArgumentSchema(shape)).toBe(shape);
  });

  it('does not close nested objects that are deliberately open', () => {
    // itemDataSchema is `z.object(fields).catchall(z.any())` because Zotero item fields are
    // an open set, and format_bibliography takes CSL-JSON as `z.record(z.any())`.
    const shape = {
      patch: z.object({ title: z.string().optional() }).catchall(z.any()).optional(),
      items: z.array(z.record(z.any())).optional(),
    };
    const schema = closedArgumentSchema(shape) as z.ZodTypeAny;
    expect(schema.safeParse({ patch: { title: 'T', extraZoteroField: 'v' } }).success).toBe(true);
    expect(schema.safeParse({ items: [{ id: 'a', anything: 1 }] }).success).toBe(true);
  });
});

describe('every registered tool', () => {
  it.each(tools.map((t) => [t.name, t] as const))('%s accepts all of its documented arguments', (_name, def) => {
    const shape = def.inputSchema;
    const args = Object.fromEntries(
      Object.entries(shape).map(([k, v]) => [k, sample(v)]),
    ) as Record<string, unknown>;
    // Values are generated, so a value-level issue is possible and uninteresting here; what
    // must never appear is a complaint about the argument NAMES the tool documents.
    expect(issuesFor(shape, args).filter((i) => i.code === 'unrecognized_keys')).toEqual([]);
  });

  it.each(tools.filter((t) => Object.keys(t.inputSchema).length > 0).map((t) => [t.name, t] as const))(
    '%s refuses an argument it does not declare',
    (_name, def) => {
      const message = unknownKeyMessage(def.inputSchema, { not_a_real_argument: 1 });
      expect(message).toContain('unknown argument `not_a_real_argument`');
    },
  );

  it('names the twin for the mistakes measured against the real library', () => {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['zotero_search_items', { query: 'kalman' }, 'this tool spells it `q`'],
      ['zotero_search_items', { itemtype: 'book' }, 'this tool spells it `itemType`'],
      ['zotero_schema', { itemType: 'book' }, 'this tool spells it `item_type`'],
      ['zotero_get_fulltext', { passages: 1 }, 'this tool spells it `max_passages`'],
      ['zotero_list_collections', { top_level: true }, 'this tool spells it `top`'],
      ['search_tools', { q: 'bibliography' }, 'this tool spells it `query`'],
      ['zotero_tag_audit', { include_automatic: true }, 'this tool spells it `include_auto`'],
      [
        'zotero_tag_audit',
        { collection_keys: ['ABCD1234'] },
        'this tool takes it inside `scope`, as `scope.collection_keys`',
      ],
      [
        'zotero_update_item',
        { creators: [] },
        'this tool takes it inside `patch`, as `patch.creators`',
      ],
      [
        'zotero_create_items',
        { itemType: 'book' },
        'this tool takes it inside `items`, as `items[].itemType`',
      ],
      ['zotero_annotate', { text: 'a passage' }, 'as `annotations[].text`'],
    ];
    for (const [tool, args, expected] of cases) {
      const def = byName.get(tool);
      expect(def, tool).toBeDefined();
      expect(unknownKeyMessage(def!.inputSchema, args), tool).toContain(expected);
    }
  });
});

async function connect(defs: ToolDefinition[], ctx: ToolContext) {
  const server = new McpServer({ name: 't', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerAllTools(server, defs, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe('through the MCP SDK', () => {
  it('advertises exactly the schema it advertised before, for all thirty tools', async () => {
    const client = await connect(tools, {} as ToolContext);
    const { tools: listed } = await client.listTools();
    expect(listed.length).toBe(30);
    for (const t of listed) {
      const def = tools.find((d) => d.name === t.name);
      const declared = Object.keys(def!.inputSchema);
      expect(Object.keys(t.inputSchema.properties ?? {}), t.name).toEqual(declared);
      // A tool with arguments already said additionalProperties:false and now means it; one
      // with none is left as the open object it has always advertised.
      expect(t.inputSchema.additionalProperties, t.name).toBe(
        declared.length > 0 ? false : undefined,
      );
    }
  });

  it('refuses an unknown argument as a tool result, without running the tool', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    const def: ToolDefinition = {
      name: 'probe',
      title: 'probe',
      description: 'probe',
      inputSchema: { q: z.string().optional() },
      handler,
    };
    const metrics = { inc: vi.fn(), observe: vi.fn() };
    const usage = { record: vi.fn() };
    const ctx = {
      metrics,
      usage,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ToolContext;
    const client = await connect([def], ctx);

    const good: any = await client.callTool({ name: 'probe', arguments: { q: 'kalman' } });
    expect(good.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledTimes(1);

    const bad: any = await client.callTool({ name: 'probe', arguments: { query: 'kalman' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('this tool spells it `q`');
    expect(handler).toHaveBeenCalledTimes(1);

    // The known cost of refusing at the SDK's validation step, true of every malformed
    // argument since long before this: the refusal never reaches observe(), so it leaves no
    // row in the usage log and no tick on the metrics counters. Recorded here so a change
    // to it is a visible one.
    expect(metrics.inc).toHaveBeenCalledTimes(1);
    expect(usage.record).toHaveBeenCalledTimes(1);
  });
});

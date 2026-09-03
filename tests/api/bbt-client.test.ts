import { describe, it, expect, vi } from 'vitest';
import { BbtClient } from '../../src/api/bbt-client.js';

describe('BbtClient', () => {
  it('ping returns false when the endpoint is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const c = new BbtClient({ fetchImpl: fetchImpl as any });
    expect(await c.ping()).toBe(false);
  });

  it('exportItems posts a JSON-RPC item.export and returns the string result', async () => {
    // Typed args: without them vi.fn infers a zero-length tuple for mock.calls and the
    // `const [url, init] = ...calls[0]!` below does not compile.
    const fetchImpl = vi.fn(async (..._args: any[]) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '@article{key, title={X}}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const c = new BbtClient({ port: 23119, fetchImpl: fetchImpl as any });
    const out = await c.exportItems({ citekeys: ['key'], translator: 'better-biblatex' });
    expect(out).toContain('@article');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:23119/better-bibtex/json-rpc');
    expect(JSON.parse((init as any).body).method).toBe('item.export');
  });

  it('throws a clear error on a JSON-RPC error body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'no such translator' } }), { status: 200 }),
    );
    const c = new BbtClient({ fetchImpl: fetchImpl as any });
    await expect(c.exportItems({ citekeys: ['k'] })).rejects.toThrow(/no such translator/);
  });
});

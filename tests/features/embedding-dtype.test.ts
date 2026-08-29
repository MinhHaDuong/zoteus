import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import {
  createEmbeddingProvider,
  embedderIdentity,
  LocalEmbeddingProvider,
  resolveTransformers,
} from '../../src/features/search/embeddings.js';

/**
 * ZOTEUS_EMBEDDING_DTYPE: what reaches the pipeline, and what the index calls the vectors.
 *
 * The local path ran at full precision because nobody passed an options object, not
 * because anyone chose fp32 — the one axis that costs the most had no knob. These tests
 * pin the knob's contract at the seam where it matters: the argument list handed to
 * pipeline(). The package is an optional dependency and is not installed here, so they
 * plant a stub of it and point ZOTEUS_TRANSFORMERS_PATH at it, the same resolution path a
 * real out-of-bundle install takes. The stub records every call's arguments.
 */

let root: string;
let stubModule: any;

/** A fresh stub root whose pipeline() rejects the named dtypes, as a real runtime does. */
function plantStub(dir: string, rejects: string[] = []): void {
  const pkg = join(dir, 'node_modules', '@huggingface', 'transformers');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
  writeFileSync(
    join(pkg, 'index.cjs'),
    `const env = { cacheDir: null };
const calls = [];
const REJECTS = ${JSON.stringify(rejects)};
async function pipeline(task, model, options) {
  calls.push({ task, model, options, argc: arguments.length });
  if (options && REJECTS.includes(options.dtype)) {
    throw new Error('Exception during initialization: unsupported dtype ' + options.dtype);
  }
  return async (input) => {
    const batch = Array.isArray(input) ? input : [input];
    return { data: new Float32Array(batch.length * 2).fill(0.5), dims: [batch.length, 2] };
  };
}
module.exports = { env, pipeline, calls };
`,
  );
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'zoteus-dtype-'));
  plantStub(root, ['fp16']);
  const specifier = resolveTransformers(root);
  expect(specifier).not.toBeNull();
  const mod = await import(specifier!);
  stubModule = mod.default ?? mod;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  stubModule.calls.length = 0;
});

/** The options object the provider actually handed to pipeline() on its single call. */
async function optionsFromOneEmbed(env: Record<string, string>): Promise<any> {
  const { provider } = createEmbeddingProvider(
    loadConfig({ ZOTEUS_EMBEDDINGS: 'local', ZOTEUS_TRANSFORMERS_PATH: root, ...env } as any),
    { debug() {}, info() {}, warn() {}, error() {} } as any,
  );
  await provider!.embed(['a passage']);
  expect(stubModule.calls).toHaveLength(1);
  return stubModule.calls[0].options;
}

describe('the dtype handed to the pipeline', () => {
  it('passes no dtype at all when the environment sets none', async () => {
    const options = await optionsFromOneEmbed({});
    // Three call shapes are distinguishable here and only one is correct. The shipped
    // code passed no options object at all; a naive implementation passes
    // `{dtype: undefined}`, whose behaviour depends on how the runtime reads an explicit
    // undefined. What must hold is that the KEY IS ABSENT.
    expect(options).toBeDefined();
    expect('dtype' in options).toBe(false);
  });

  it('passes the configured dtype through verbatim', async () => {
    expect(await optionsFromOneEmbed({ ZOTEUS_EMBEDDING_DTYPE: 'q8' })).toEqual({ dtype: 'q8' });
  });

  it('does not enumerate valid values, so a runtime that gains one needs no release here', async () => {
    // The valid set belongs to the runtime. A local allowlist would rot against it, and
    // its failure mode is refusing a value that works.
    expect(await optionsFromOneEmbed({ ZOTEUS_EMBEDDING_DTYPE: 'some-future-dtype' })).toEqual({
      dtype: 'some-future-dtype',
    });
  });

  it('never passes a device, whatever the environment says', async () => {
    // A knob nobody added is exactly what a later well-meaning patch adds back, so this
    // asserts the absence rather than trusting it. `device: 'auto'` is measured to fail
    // the session on linux-x64 with no CUDA runtime: ONNX Runtime is handed the whole
    // provider list and registers CUDA unconditionally there.
    for (const env of [{}, { ZOTEUS_EMBEDDING_DTYPE: 'q8' }, { ZOTEUS_EMBEDDING_DEVICE: 'cuda' } as any]) {
      stubModule.calls.length = 0;
      expect('device' in (await optionsFromOneEmbed(env))).toBe(false);
    }
  });
});

describe('a dtype the runtime will not load', () => {
  it('reports the value and the model rather than substituting another precision', async () => {
    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: root, dtype: 'fp16' });

    await expect(provider.embed(['a passage'])).rejects.toThrow(/ZOTEUS_EMBEDDING_DTYPE=fp16/);
    // One attempt, at the requested precision. A retry at the default would produce
    // vectors the index has already labelled fp16 — see the identity test below.
    expect(stubModule.calls.map((c: any) => c.options)).toEqual([{ dtype: 'fp16' }]);
  });

  it('names the model and the remedy, because the fix is one environment variable', async () => {
    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: root, dtype: 'fp16' });
    await expect(provider.embed(['a passage'])).rejects.toThrow(/Xenova\/all-MiniLM-L6-v2/);
    await expect(provider.embed(['a passage'])).rejects.toThrow(/keyword \(BM25\) search still works/);
  });

  it('never changes the precision it claims, before or after a failed load', async () => {
    // The index stamps the embedder identity BEFORE the first embed. A provider that
    // downgraded here would leave the stored vectors labelled with a precision they do
    // not have, and since quantisation does not change vector width, nothing downstream
    // could notice. So the identity is constant, and the load either honours it or fails.
    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: root, dtype: 'fp16' });
    expect(embedderIdentity(provider)).toBe('local:Xenova/all-MiniLM-L6-v2@fp16');
    await expect(provider.embed(['a passage'])).rejects.toThrow();
    expect(embedderIdentity(provider)).toBe('local:Xenova/all-MiniLM-L6-v2@fp16');
  });

  it('propagates a failure that has nothing to do with dtype', async () => {
    // With no dtype requested there is nothing to fall back to, and swallowing the error
    // would turn a broken install into an index of zero vectors with no explanation.
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-dtype-hard-'));
    plantStub(dir, []);
    const pkg = join(dir, 'node_modules', '@huggingface', 'transformers');
    writeFileSync(
      join(pkg, 'index.cjs'),
      `const env = { cacheDir: null };
async function pipeline() { throw new Error('native module is broken'); }
module.exports = { env, pipeline };
`,
    );
    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: dir });
    await expect(provider.embed(['a passage'])).rejects.toThrow('native module is broken');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('dtype in the vector-space identity', () => {
  it('separates two precisions of one model', () => {
    // Measured on Xenova/all-MiniLM-L6-v2: q8 against the fp32 default is 0.992652
    // cosine. Ranking one against the other is not a rounding question.
    expect(embedderIdentity({ name: 'local', model: 'm', dtype: 'q8' })).not.toEqual(
      embedderIdentity({ name: 'local', model: 'm', dtype: 'uint8' }),
    );
  });

  it('stores no vector it cannot label truthfully', async () => {
    // The integration the unit tests above cannot reach, and the one that matters:
    // `build()` stamps `vectorEmbedderId` from the provider's identity while the records
    // are still UNEMBEDDED. So a provider whose precision moved between that stamp and
    // the embed would write vectors of one precision under the label of another, and
    // nothing downstream could notice — quantisation does not change the vector width, so
    // the query path's dimension check sees nothing wrong and the identity string is the
    // only defence there is.
    //
    // Run against a precision the runtime refuses, which is the only case where the two
    // could ever diverge. The contract is that the index comes out of it holding NO
    // vectors, rather than holding default-precision vectors labelled fp16.
    const index = new MemorySearchIndex({
      embedder: new LocalEmbeddingProvider(undefined, undefined, { transformersPath: root, dtype: 'fp16' }),
      configured: 'local',
      logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
    });
    const status = await index.build([
      { key: 'A', data: { itemType: 'journalArticle', title: 'Vectors', abstractNote: 'body' } },
    ]);

    expect(status.vectors).toBe(0);
    expect(status.embedderActive).toBe(false);
    expect(status.embedderReason).toMatch(/fp16/);
    // Keyword search is untouched: the passages are indexed, only the ranking is off.
    expect(status.documents).toBeGreaterThan(0);
  });

  it('leaves an index built before this option existed exactly as it was', () => {
    // The field appearing must not invalidate every stored vector on upgrade.
    expect(embedderIdentity({ name: 'local', model: 'm' })).toBe('local:m');
    expect(embedderIdentity({ name: 'openai', model: 'text-embedding-3-small' })).toBe(
      'openai:text-embedding-3-small',
    );
  });
});

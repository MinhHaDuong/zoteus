import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  LocalEmbeddingProvider,
  embedderIdentity,
  resolveTransformers,
} from '../../src/features/search/embeddings.js';
import {
  APPLIED_FIELDS,
  DECLARED_ONLY_FIELDS,
  EMBEDDER_REGISTRY_VERSION,
  ENTRY_METADATA_FIELDS,
  INCUMBENT_LOCAL_ENTRY,
} from '../../src/features/search/embedder-registry.js';

/**
 * Characterization of the incumbent local embedder.
 *
 * This suite does not say what the embedder *should* do. It says what it *does*, today,
 * and it exists so that moving the configuration out of the constructor chain and into a
 * registry entry can be shown to have changed nothing. Every literal below is a second,
 * independent copy of a value that also lives in the source — deliberately, because a test
 * that reads its expectation from the code under test asserts nothing.
 *
 * Two arms:
 *
 *  - The configuration arm runs everywhere. It freezes the entry's fields, the vector key
 *    an index on disk carries, and what the loader hands the pipeline and the extractor.
 *  - The vector arm freezes the actual floats and needs @huggingface/transformers, which is
 *    an optional dependency of about 700 MB and is not installed for the test suite. It
 *    runs when ZOTEUS_TRANSFORMERS_PATH points at an install (ZOTEUS_TEST_MODEL_CACHE_DIR,
 *    test-only, points at a weights cache so the run stays offline) and skips otherwise.
 *    A skipped arm proves nothing, so its evidence is recorded per run in ticket 0489,
 *    together with the perturbation that showed it red.
 *
 * The long passage is 660 tokens and is here on purpose: the pipeline truncates it at the
 * tokenizer's model_max_length of 512, not at the 256-token window the model's own card
 * declares. Enforcing the declared window would move that vector, so this fixture is what
 * makes such a change visible instead of silent.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../fixtures/embedder-minilm-characterization.json', import.meta.url),
    'utf8',
  ),
);

/** Rebuilt rather than stored, so a drift in the generator shows up as a hash mismatch. */
function longPassage(): string {
  return Array.from(
    { length: 40 },
    (_, i) =>
      `Segment ${i + 1} discusses tariff schedules, permit auctions and border adjustment in year ${2000 + i}.`,
  ).join(' ');
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('incumbent local embedder: the registry entry', () => {
  it('declares every field of the chain, with the values the chain runs today', () => {
    expect(EMBEDDER_REGISTRY_VERSION).toBe(1);
    expect(INCUMBENT_LOCAL_ENTRY).toMatchObject({
      id: 'minilm-l6-v2',
      model: 'Xenova/all-MiniLM-L6-v2',
      revision: 'main',
      device: 'cpu',
      dtype: 'fp32',
      graphFile: 'onnx/model.onnx',
      pooling: 'mean',
      normalize: true,
      template: { query: '', passage: '' },
      windowTokens: 256,
      dimension: 384,
    });
  });

  it("sources every declared value, so none of them is somebody's recollection", () => {
    for (const field of [...APPLIED_FIELDS, ...DECLARED_ONLY_FIELDS]) {
      expect(INCUMBENT_LOCAL_ENTRY.sources[field], `no source recorded for ${field}`).toBeTruthy();
    }
  });

  it('is the only entry: no selector, no alternative', async () => {
    const registry: Record<string, unknown> =
      await import('../../src/features/search/embedder-registry.js');
    const entries = Object.entries(registry).filter(
      ([, v]) => v && typeof v === 'object' && !Array.isArray(v) && 'model' in (v as object),
    );
    expect(entries.map(([name]) => name)).toEqual(['INCUMBENT_LOCAL_ENTRY']);
  });

  it('partitions its fields into applied and declared-only, with nothing falling between', () => {
    const claimed = [...APPLIED_FIELDS, ...DECLARED_ONLY_FIELDS, ...ENTRY_METADATA_FIELDS];
    expect(new Set(claimed).size, 'a field is claimed twice').toBe(claimed.length);
    expect([...claimed].sort()).toEqual(Object.keys(INCUMBENT_LOCAL_ENTRY).sort());
    // Frozen on purpose: this list shrinks only when a field is genuinely made authoritative.
    expect([...APPLIED_FIELDS]).toEqual(['model', 'pooling', 'normalize']);
  });
});

describe('incumbent local embedder: the vector key an index carries', () => {
  it('is local:Xenova/all-MiniLM-L6-v2', () => {
    const provider = new LocalEmbeddingProvider();
    expect(embedderIdentity(provider)).toBe('local:Xenova/all-MiniLM-L6-v2');
    expect(embedderIdentity(provider)).toBe(FIXTURE.vectorKey);
  });
});

describe('incumbent local embedder: what the loader hands the runtime', () => {
  const DEFAULT_STUB_CACHE = '/stub/default/.cache';
  let root: string;
  let stub: any;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'zoteus-embedder-chain-'));
    const pkg = join(root, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }),
    );
    writeFileSync(
      join(pkg, 'index.cjs'),
      `const env = { cacheDir: ${JSON.stringify(DEFAULT_STUB_CACHE)} };
const pipelineArgs = [];
const extractorOptions = [];
async function pipeline(...args) {
  pipelineArgs.push(args);
  return async (input, options) => {
    extractorOptions.push(options);
    const batch = Array.isArray(input) ? input : [input];
    return { data: new Float32Array(batch.length * 3).fill(0.25), dims: [batch.length, 3] };
  };
}
module.exports = { env, pipeline, pipelineArgs, extractorOptions };
`,
    );
    const specifier = resolveTransformers(root);
    expect(specifier).not.toBeNull();
    const mod = await import(specifier!);
    stub = mod.default ?? mod;
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("names the entry's model to the pipeline, and passes nothing else", async () => {
    stub.pipelineArgs.length = 0;
    stub.extractorOptions.length = 0;
    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: root });
    await provider.embed(['a passage']);
    expect(stub.pipelineArgs).toEqual([['feature-extraction', 'Xenova/all-MiniLM-L6-v2']]);
  });

  it('pools by mean and normalizes, and asks for nothing the entry does not declare', async () => {
    stub.pipelineArgs.length = 0;
    stub.extractorOptions.length = 0;
    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: root });
    await provider.embed(['a passage', 'another passage']);
    expect(stub.extractorOptions).toEqual([{ pooling: 'mean', normalize: true }]);
  });

  it('prefixes neither queries nor passages', async () => {
    const seen: string[][] = [];
    const provider = new LocalEmbeddingProvider(undefined, async () => {
      return async (texts: string[]) => {
        seen.push(texts);
        return { data: new Float32Array(texts.length * 3).fill(0.25), dims: [texts.length, 3] };
      };
    });
    await provider.embed(['how does carbon pricing change industrial investment?']);
    expect(seen).toEqual([['how does carbon pricing change industrial investment?']]);
  });
});

const transformersPath = process.env.ZOTEUS_TRANSFORMERS_PATH;
const runtimeAvailable = resolveTransformers(transformersPath) !== null;

describe('incumbent local embedder: the frozen vectors', () => {
  it.skipIf(!runtimeAvailable)(
    'reproduces the frozen query, passage and truncated-long-passage vectors exactly',
    async () => {
      const texts = [FIXTURE.texts.query, FIXTURE.texts.passage, longPassage()];
      expect(sha256(texts[2]!)).toBe(FIXTURE.texts.longSha256);

      const provider = new LocalEmbeddingProvider(undefined, undefined, {
        transformersPath,
        modelCacheDir: process.env.ZOTEUS_TEST_MODEL_CACHE_DIR,
      });
      const [query, passage, long] = await provider.embed(texts);

      expect(query!.length).toBe(384);
      expect(query!.length).toBe(FIXTURE.dimension);
      expect(query).toEqual(FIXTURE.vectors.query);
      expect(passage).toEqual(FIXTURE.vectors.passage);
      expect(long).toEqual(FIXTURE.vectors.long);
      expect([passage!.length, long!.length]).toEqual([384, 384]);
    },
    300_000,
  );
});

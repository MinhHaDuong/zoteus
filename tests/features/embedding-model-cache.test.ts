import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import {
  createEmbeddingProvider,
  LocalEmbeddingProvider,
  resolveTransformers,
} from '../../src/features/search/embeddings.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

/**
 * The weights are the index's largest artifact, and the transformers package caches them
 * inside its own install by default — which outlives the data directory, whose deletion is
 * supposed to be the whole uninstall. These tests pin the contract: the cache directory is
 * set under <dataDir> BEFORE the pipeline is constructed, i.e. before anything downloads.
 *
 * The package itself is an optional dependency and not installed here, so the tests plant
 * a stub of it in a temp directory and point ZOTEUS_TRANSFORMERS_PATH at it — the same
 * resolution path a real out-of-bundle install takes. The stub's pipeline() records what
 * env.cacheDir held at construction time.
 */

const DEFAULT_STUB_CACHE = '/stub/default/.cache';
let root: string; // temp dir handed to ZOTEUS_TRANSFORMERS_PATH
let stubModule: any; // the one live instance of the stub (ESM module cache)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'zoteus-model-cache-'));
  const pkg = join(root, 'node_modules', '@huggingface', 'transformers');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }),
  );
  writeFileSync(
    join(pkg, 'index.cjs'),
    `const env = { cacheDir: ${JSON.stringify(DEFAULT_STUB_CACHE)} };
const seen = [];
async function pipeline() {
  seen.push(env.cacheDir); // what the cache pointed at when the pipeline was constructed
  const extractor = async (input) => {
    const batch = Array.isArray(input) ? input : [input];
    return { data: new Float32Array(batch.length * 384).fill(0.5), dims: [batch.length, 384] };
  };
  extractor.tokenizer = { model_max_length: 512 };
  return extractor;
}
module.exports = { env, pipeline, seen };
`,
  );
  const specifier = resolveTransformers(root);
  expect(specifier).not.toBeNull();
  const mod = await import(specifier!);
  stubModule = mod.default ?? mod;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // One module instance serves every test (ESM cache): reset what a previous test set.
  stubModule.env.cacheDir = DEFAULT_STUB_CACHE;
  stubModule.seen.length = 0;
});

describe('model weights land under the data directory', () => {
  it('pins the cache under <dataDir>/models before the pipeline is constructed', async () => {
    const dataDir = join(root, 'data');
    const config = loadConfig({
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_TRANSFORMERS_PATH: root,
      ZOTEUS_DATA_DIR: dataDir,
    } as any);
    const { provider, unavailable } = createEmbeddingProvider(config, silentLogger);
    expect(unavailable).toBeUndefined();

    const vecs = await provider!.embed(['a passage']);
    expect(vecs).toHaveLength(1);
    expect(vecs[0]).toHaveLength(384);
    expect(vecs[0]!.every((value) => value === 0.5)).toBe(true);
    // Deleting dataDir now removes the weights along with the index.
    expect(stubModule.seen).toEqual([join(dataDir, 'models')]);
    expect(stubModule.env.cacheDir).toBe(join(dataDir, 'models'));
  });

  it('leaves the package default alone when no cache directory is given', async () => {
    // Direct construction without the option: existing callers see no behaviour change.
    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: root });
    await provider.embed(['a passage']);
    expect(stubModule.seen).toEqual([DEFAULT_STUB_CACHE]);
    expect(stubModule.env.cacheDir).toBe(DEFAULT_STUB_CACHE);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import {
  EMBEDDER_ENTRIES,
  INCUMBENT_LOCAL_ENTRY,
  selectEmbedderEntry,
} from '../../src/features/search/embedder-registry.js';
import { createEmbeddingProvider } from '../../src/features/search/embeddings.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';

let runtimeRoot: string;

beforeAll(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), 'zoteus-selector-'));
  const pkg = join(runtimeRoot, 'node_modules', '@huggingface', 'transformers');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
  writeFileSync(join(pkg, 'index.cjs'), 'module.exports = { pipeline: async () => {} };');
});

afterAll(() => rmSync(runtimeRoot, { recursive: true, force: true }));

describe('curated local embedder selector', () => {
  it('contains measured CPU candidates except the evidence-rejected cell', () => {
    expect(Object.keys(EMBEDDER_ENTRIES)).toHaveLength(18);
    expect(EMBEDDER_ENTRIES['minilm-l6-v2']).toEqual(INCUMBENT_LOCAL_ENTRY);
    expect(EMBEDDER_ENTRIES['multilingual-e5-small-q8']).toMatchObject({
      model: 'Xenova/multilingual-e5-small',
      revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
      dtype: 'q8',
      graphFile: 'onnx/model_quantized.onnx',
      pooling: 'mean',
      normalize: true,
      template: { query: 'query: ', passage: 'passage: ' },
      windowTokens: 512,
      dimension: 384,
    });
    for (const model of [
      'granite-97m-multilingual-r2',
      'granite-311m-multilingual-r2',
      'arctic-embed-m-v2',
      'gte-multilingual-base',
      'multilingual-e5-small',
      'multilingual-e5-base',
    ]) {
      for (const dtype of ['fp32', 'q8', 'uint8']) {
        if (model === 'granite-97m-multilingual-r2' && dtype === 'q8') continue;
        expect(EMBEDDER_ENTRIES[`${model}-${dtype}`], `${model}-${dtype}`).toBeDefined();
      }
    }
    expect(EMBEDDER_ENTRIES['granite-97m-multilingual-r2-q8']).toBeUndefined();
  });

  it('selects MiniLM when unset and rejects unknown ids', () => {
    expect(selectEmbedderEntry()).toBe(INCUMBENT_LOCAL_ENTRY);
    expect(() => selectEmbedderEntry('arbitrary/hf-model')).toThrow(
      /unknown local embedder entry/i,
    );
  });

  it('uses ZOTEUS_EMBEDDING_MODEL as an entry id on the local provider', () => {
    const cfg = loadConfig({
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_EMBEDDING_MODEL: 'multilingual-e5-small-q8',
      ZOTEUS_TRANSFORMERS_PATH: runtimeRoot,
    } as any);
    const selection = createEmbeddingProvider(cfg);
    expect(selection.provider).toMatchObject({ entryId: 'multilingual-e5-small-q8' });
    expect(selection.configured).toBe('local');
    expect(new MemorySearchIndex({ embedder: selection.provider! }).status().embedderModel)
      .toBe('multilingual-e5-small-q8');
  });

  it.each(['not-a-row', 'Xenova/all-MiniLM-L6-v2'])(
    'degrades an unknown or leftover local id %s before probing the optional runtime',
    (entryId) => {
      const cfg = loadConfig({
        ZOTEUS_EMBEDDINGS: 'local',
        ZOTEUS_EMBEDDING_MODEL: entryId,
      } as any);
      const selection = createEmbeddingProvider(cfg);
      expect(selection).toMatchObject({
        provider: null,
        configured: 'local',
        unavailable: expect.stringMatching(/unknown local embedder entry/i),
      });
      expect(selection.unavailable).toMatch(/keyword.*still works/i);
      expect(selection.unavailable).toContain(entryId);
      const status = new MemorySearchIndex({
        embedder: selection.provider,
        configured: selection.configured,
        unavailable: selection.unavailable,
      }).status();
      expect(status).toMatchObject({
        embedderActive: false,
        embedderConfigured: 'local',
        embedderReason: expect.stringContaining(entryId),
      });
    },
  );
});

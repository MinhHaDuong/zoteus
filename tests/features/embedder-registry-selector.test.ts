import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  EMBEDDER_ENTRIES,
  INCUMBENT_LOCAL_ENTRY,
  selectEmbedderEntry,
} from '../../src/features/search/embedder-registry.js';
import {
  createEmbeddingProvider,
  LocalEmbeddingProvider,
} from '../../src/features/search/embeddings.js';

describe('curated local embedder selector', () => {
  it('contains the incumbent plus every measured CPU candidate/rung', () => {
    expect(Object.keys(EMBEDDER_ENTRIES)).toHaveLength(19);
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
        expect(EMBEDDER_ENTRIES[`${model}-${dtype}`], `${model}-${dtype}`).toBeDefined();
      }
    }
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
    } as any);
    const selection = createEmbeddingProvider(cfg);
    // An absent optional runtime may degrade the provider; selection itself must still
    // validate before any model/index access. Exercise construction through the exported selector.
    const provider = new LocalEmbeddingProvider(
      selectEmbedderEntry(cfg.embeddingModel),
      vi.fn() as any,
    );
    expect(provider.entry.id).toBe('multilingual-e5-small-q8');
    expect(selection.configured).toBe('local');
  });

  it('fails an unknown local id before probing the optional runtime', () => {
    const cfg = loadConfig({
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_EMBEDDING_MODEL: 'not-a-row',
    } as any);
    expect(() => createEmbeddingProvider(cfg)).toThrow(/unknown local embedder entry/i);
  });
});

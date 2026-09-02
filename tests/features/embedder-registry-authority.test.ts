import { describe, expect, it, vi } from 'vitest';
import {
  INCUMBENT_LOCAL_ENTRY,
  entryFingerprint,
  parseEmbedderEntry,
  type EmbedderEntry,
} from '../../src/features/search/embedder-registry.js';
import { LocalEmbeddingProvider, embedderIdentity } from '../../src/features/search/embeddings.js';

function changed<K extends keyof EmbedderEntry>(key: K, value: EmbedderEntry[K]): EmbedderEntry {
  return { ...INCUMBENT_LOCAL_ENTRY, [key]: value };
}

describe('authoritative embedder records', () => {
  it.each([
    ['model', 'example/model'],
    ['revision', 'deadbeef'],
    ['dtype', 'q8'],
    ['graphFile', 'onnx/model_quantized.onnx'],
    ['pooling', 'cls'],
    ['normalize', false],
    ['template', { query: 'query: ', passage: 'passage: ' }],
    ['windowTokens', 128],
    ['dimension', 768],
  ] as const)('changes the fingerprint when %s changes', (key, value) => {
    expect(entryFingerprint(changed(key as any, value as any))).not.toBe(
      entryFingerprint(INCUMBENT_LOCAL_ENTRY),
    );
  });

  it('does not fingerprint display metadata or source notes', () => {
    expect(
      entryFingerprint({
        ...INCUMBENT_LOCAL_ENTRY,
        id: 'display-name',
        sources: { changed: 'yes' },
      }),
    ).toBe(entryFingerprint(INCUMBENT_LOCAL_ENTRY));
  });

  it('keeps the incumbent persisted identity unchanged', () => {
    expect(embedderIdentity(new LocalEmbeddingProvider())).toBe('local:Xenova/all-MiniLM-L6-v2');
  });

  it('rejects unknown and incomplete records', () => {
    expect(() => parseEmbedderEntry({ ...INCUMBENT_LOCAL_ENTRY, surprise: true })).toThrow(
      /unknown field/i,
    );
    const { dimension: _dimension, ...incomplete } = INCUMBENT_LOCAL_ENTRY;
    expect(() => parseEmbedderEntry(incomplete)).toThrow(/dimension/i);
    expect(() => parseEmbedderEntry({ ...INCUMBENT_LOCAL_ENTRY, pooling: 'none' })).toThrow(
      /pooling/i,
    );
    expect(() => parseEmbedderEntry({ ...INCUMBENT_LOCAL_ENTRY, revision: 'main' })).toThrow(
      /commit sha/i,
    );
  });

  it('returns immutable rows so vectors cannot move under a captured fingerprint', () => {
    const row = parseEmbedderEntry({ ...INCUMBENT_LOCAL_ENTRY });
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.template)).toBe(true);
    expect(Object.isFrozen(row.sources)).toBe(true);
  });

  it('drives loader options and role templates and verifies the tokenizer window', async () => {
    const calls: any[] = [];
    const extractor: any = vi.fn(async (texts: string[], options: unknown) => {
      calls.push({ texts, options });
      return { data: new Float32Array(texts.length * 4), dims: [texts.length, 4] };
    });
    extractor.tokenizer = { model_max_length: 17 };
    const entry = parseEmbedderEntry({
      ...INCUMBENT_LOCAL_ENTRY,
      id: 'test-e5',
      model: 'example/e5',
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dtype: 'q8',
      graphFile: 'onnx/model_quantized.onnx',
      pooling: 'cls',
      template: { query: 'query: ', passage: 'passage: ' },
      windowTokens: 17,
      dimension: 4,
    });
    const provider = new LocalEmbeddingProvider(entry, async () => extractor);

    await provider.embed(['question'], 'query');
    await provider.embed(['answer'], 'passage');

    expect(calls).toEqual([
      { texts: ['query: question'], options: { pooling: 'cls', normalize: true } },
      { texts: ['passage: answer'], options: { pooling: 'cls', normalize: true } },
    ]);
    expect(provider.loaderOptions).toEqual({
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dtype: 'q8',
      subfolder: 'onnx',
      model_file_name: 'model',
    });
    expect(extractor.tokenizer.model_max_length).toBe(17);
  });

  it('rejects the removed raw-model constructor seam', () => {
    expect(() => new LocalEmbeddingProvider('example/model' as any)).toThrow(/complete registry entry/i);
  });

  it('fails before inference when the pinned tokenizer window disagrees', async () => {
    const extractor: any = vi.fn();
    extractor.tokenizer = { model_max_length: 999 };
    const provider = new LocalEmbeddingProvider(
      { ...INCUMBENT_LOCAL_ENTRY, windowTokens: 17 },
      async () => extractor,
    );
    await expect(provider.embed(['x'])).rejects.toThrow(/tokenizer window.*999.*17/i);
    expect(extractor).not.toHaveBeenCalled();
  });

  it('fails when the runtime emits the wrong dimension', async () => {
    const extractor: any = async () => ({ data: new Float32Array(4), dims: [1, 4] });
    extractor.tokenizer = { model_max_length: 512 };
    const provider = new LocalEmbeddingProvider(
      { ...INCUMBENT_LOCAL_ENTRY, dimension: 5 },
      async () => extractor,
    );
    await expect(provider.embed(['x'])).rejects.toThrow(/expected 5/i);
  });

  it('rejects token-level and malformed tensor shapes', async () => {
    const extractor: any = async () => ({ data: new Float32Array(8), dims: [1, 2, 4] });
    extractor.tokenizer = { model_max_length: 512 };
    const provider = new LocalEmbeddingProvider(
      { ...INCUMBENT_LOCAL_ENTRY, dimension: 4 },
      async () => extractor,
    );
    await expect(provider.embed(['x'])).rejects.toThrow(/tensor shape/i);
  });
});

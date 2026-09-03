import { describe, expect, it, vi } from 'vitest';
import {
  APPLIED_FIELDS,
  EMBEDDER_FINGERPRINT_VERSION,
  EMBEDDER_REGISTRY_VERSION,
  FINGERPRINT_PROJECTION_V1,
  INCUMBENT_LOCAL_ENTRY,
  LEGACY_INCUMBENT_FINGERPRINT,
  entryFingerprint,
  parseEmbedderEntry,
  type EmbedderEntry,
} from '../../src/features/search/embedder-registry.js';
import { LocalEmbeddingProvider, embedderIdentity } from '../../src/features/search/embeddings.js';

function perturbProjectedField(field: (typeof APPLIED_FIELDS)[number]): EmbedderEntry {
  const value: unknown = INCUMBENT_LOCAL_ENTRY[field];
  const changed =
    typeof value === 'string'
      ? `${value}-changed`
      : typeof value === 'number'
        ? value + 1
        : typeof value === 'boolean'
          ? !value
          : {
              query: `${INCUMBENT_LOCAL_ENTRY.template.query}changed: `,
              passage: INCUMBENT_LOCAL_ENTRY.template.passage,
            };
  return { ...INCUMBENT_LOCAL_ENTRY, [field]: changed } as EmbedderEntry;
}

describe('authoritative embedder records', () => {
  it.each(FINGERPRINT_PROJECTION_V1.map(([field]) => field))(
    'changes the fingerprint when projected field %s changes',
    (field) => {
      expect(entryFingerprint(perturbProjectedField(field))).not.toBe(
        entryFingerprint(INCUMBENT_LOCAL_ENTRY),
      );
    },
  );

  it('canonicalizes template query and passage order in the projection', () => {
    const reordered = {
      passage: INCUMBENT_LOCAL_ENTRY.template.passage,
      query: INCUMBENT_LOCAL_ENTRY.template.query,
    };
    expect(entryFingerprint({ ...INCUMBENT_LOCAL_ENTRY, template: reordered })).toBe(
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

  it('keeps record-schema evolution outside the stable vector fingerprint', () => {
    const registryV1 = { schemaVersion: EMBEDDER_REGISTRY_VERSION, entry: INCUMBENT_LOCAL_ENTRY };
    const registryV2 = { ...registryV1, schemaVersion: EMBEDDER_REGISTRY_VERSION + 1 };
    expect(entryFingerprint(registryV2.entry)).toBe(entryFingerprint(registryV1.entry));
    expect(EMBEDDER_FINGERPRINT_VERSION).toBe(1);
    expect(LEGACY_INCUMBENT_FINGERPRINT).toBe(
      '098eda2e37ba648b3a022a2a87f37f343b46b24812c24a73317b4e709971ee50',
    );
    expect(entryFingerprint(INCUMBENT_LOCAL_ENTRY)).toBe(LEGACY_INCUMBENT_FINGERPRINT);
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
      device: 'cpu',
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
    await expect(provider.embed(['x'])).rejects.toThrow(/cannot apply.*tokenizer window/i);
    expect(extractor).not.toHaveBeenCalled();
  });

  it('applies a smaller registry tokenizer cap to preprocessing', async () => {
    const tokenizer = vi.fn(() => ({}));
    Object.defineProperty(tokenizer, 'model_max_length', { value: 512 });
    const extractor: any = vi.fn(async (texts: string[]) => {
      extractor.tokenizer(texts, { padding: true, truncation: true });
      return { data: new Float32Array(4), dims: [1, 4] };
    });
    extractor.tokenizer = tokenizer;
    const provider = new LocalEmbeddingProvider(
      { ...INCUMBENT_LOCAL_ENTRY, windowTokens: 17, dimension: 4 },
      async () => extractor,
    );
    await provider.embed(['a deliberately long input']);
    expect(tokenizer).toHaveBeenCalledWith(expect.anything(), {
      padding: true,
      truncation: true,
      max_length: 17,
    });
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

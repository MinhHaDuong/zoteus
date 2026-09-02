import { describe, it, expect, vi } from 'vitest';
import { LocalEmbeddingProvider } from '../../src/features/search/embeddings.js';

/**
 * A stand-in for the transformers.js feature-extraction pipeline: callable on a batch,
 * carrying a `tokenizer` that publishes its window and counts whitespace tokens plus the
 * two special tokens, the way the real one does for the incumbent model.
 */
function pipelineWithWindow(window: number) {
  const calls: string[][] = [];
  const tokenizer = Object.assign(
    (text: string, opts: { truncation?: boolean }) => {
      expect(opts.truncation).toBe(false); // counted untruncated, or the count is a lie
      const n = text.split(/\s+/).filter(Boolean).length + 2;
      return { input_ids: { dims: [1, n], data: new Array(n).fill(0) } };
    },
    { model_max_length: window },
  );
  const extractor = Object.assign(
    async (batch: string[]) => {
      calls.push(batch);
      return { data: new Float32Array(batch.length * 4).fill(0.5), dims: [batch.length, 4] };
    },
    { tokenizer },
  );
  return { extractor, calls };
}

describe('the embed call asserts the model window before embedding', () => {
  it('embeds texts inside the window and reports the window it read', async () => {
    const { extractor, calls } = pipelineWithWindow(8);
    const provider = new LocalEmbeddingProvider('test-model', async () => extractor);
    expect(await provider.maxTokens()).toBe(8);
    const vecs = await provider.embed(['one two three', 'four five six']);
    expect(vecs).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('throws on an over-length text, naming it, and never reaches the runtime', async () => {
    const { extractor, calls } = pipelineWithWindow(8);
    const provider = new LocalEmbeddingProvider('test-model', async () => extractor, { batchSize: 2 });
    const long = 'one two three four five six seven eight nine ten';
    await expect(provider.embed(['short one', 'fine', long])).rejects.toThrow(/text 2 is 12 tokens, over the model's 8-token window/);
    // The first batch of two went through; the batch holding the over-length text did not.
    expect(calls).toHaveLength(1);
  });

  it('asserts nothing when the runtime publishes no window, and says so through maxTokens', async () => {
    const bare = vi.fn(async (batch: string[]) => ({
      data: new Float32Array(batch.length * 4).fill(0.5),
      dims: [batch.length, 4],
    }));
    const provider = new LocalEmbeddingProvider('test-model', async () => bare);
    expect(await provider.maxTokens()).toBeNull();
    await provider.embed(['anything at all, however long ' + 'x '.repeat(2000)]);
    expect(bare).toHaveBeenCalledTimes(1);
  });

  it('treats the unset-window sentinel as no window', async () => {
    const { extractor } = pipelineWithWindow(1e30);
    const provider = new LocalEmbeddingProvider('test-model', async () => extractor);
    expect(await provider.maxTokens()).toBeNull();
  });
});

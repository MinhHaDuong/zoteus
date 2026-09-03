import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import {
  DEFAULT_LOCAL_MODEL,
  DEFAULT_POOLING,
  LocalEmbeddingProvider,
  MODEL_POOLING,
  createEmbeddingProvider,
  embedderIdentity,
  inputPrefixes,
  poolingFor,
  resolveTransformers,
} from '../../src/features/search/embeddings.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

/**
 * Pooling is decided when a model is trained, published only on its source repository, and
 * stood as a literal at the one call site the pipeline has. That literal was right for
 * MiniLM and E5 and wrong for every CLS-pooled model ZOTEUS_EMBEDDING_MODEL can now name,
 * which retrieves worse without ever failing. These tests pin the table that replaces the
 * literal: what it says, that what it says reaches the pipeline call, and that a model it
 * does not know, the default included, is treated exactly as before.
 */

/** An extractor that records every batch and the options it was called with. */
function recordingExtractor(dim = 4): {
  calls: { input: string[]; options: unknown }[];
  extractor: (input: string | string[], options: unknown) => Promise<any>;
} {
  const calls: { input: string[]; options: unknown }[] = [];
  return {
    calls,
    extractor: async (input: string | string[], options: unknown) => {
      const batch = Array.isArray(input) ? input : [input];
      calls.push({ input: batch, options });
      return { data: new Float32Array(batch.length * dim).fill(0.5), dims: [batch.length, dim] };
    },
  };
}

describe('the pooling table', () => {
  it('lists the default and the documented multilingual pick as mean, which is what they always got', () => {
    expect(poolingFor(DEFAULT_LOCAL_MODEL)).toBe('mean');
    expect(poolingFor('Xenova/multilingual-e5-small')).toBe('mean');
    expect(poolingFor('intfloat/e5-base-v2')).toBe('mean');
    expect(DEFAULT_POOLING).toBe('mean');
  });

  it('lists the CLS-pooled models the literal was measured to hurt, under either id', () => {
    for (const id of [
      'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
      'ibm-granite/granite-embedding-97m-multilingual-r2',
      'onnx-community/gte-multilingual-base',
      'Alibaba-NLP/gte-multilingual-base',
      'Snowflake/snowflake-arctic-embed-m-v2.0',
    ]) {
      expect(poolingFor(id), id).toBe('cls');
    }
  });

  it('keeps the historical mean for a model it does not know, rather than refusing it', () => {
    expect(MODEL_POOLING['some-org/a-model-published-yesterday']).toBeUndefined();
    expect(poolingFor('some-org/a-model-published-yesterday')).toBe('mean');
    expect(poolingFor('')).toBe('mean');
  });

  it('spells every id the way transformers.js resolves it: an org, a slash, a repository', () => {
    for (const id of Object.keys(MODEL_POOLING)) {
      expect(id, id).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });
});

describe('the pooling the pipeline is asked for', () => {
  it('is the table’s, not the call site’s', async () => {
    const { calls, extractor } = recordingExtractor();
    const provider = new LocalEmbeddingProvider('onnx-community/gte-multilingual-base', async () => extractor);
    await provider.embed(['une pompe à chaleur']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ pooling: 'cls', normalize: true });
  });

  it('is exactly what the incumbent always got, for the default model and for E5', async () => {
    // The literal that stood at the call site was `{ pooling: 'mean', normalize: true }`.
    // For the models every existing index was built with, the table must reproduce it key
    // for key, or those indexes silently stop matching the queries run against them.
    for (const model of [DEFAULT_LOCAL_MODEL, 'Xenova/multilingual-e5-small']) {
      const { calls, extractor } = recordingExtractor();
      await new LocalEmbeddingProvider(model, async () => extractor).embed(['a passage'], 'passage');
      expect(calls[0]!.options, model).toEqual({ pooling: 'mean', normalize: true });
    }
  });

  it('is the historical mean for a model the table does not know', async () => {
    const { calls, extractor } = recordingExtractor();
    await new LocalEmbeddingProvider('some-org/a-model-published-yesterday', async () => extractor).embed(['x']);
    expect(calls[0]!.options).toEqual({ pooling: 'mean', normalize: true });
  });

  it('changes neither the identity nor the prefixes, which the model id already decides', () => {
    const cls = new LocalEmbeddingProvider('onnx-community/gte-multilingual-base');
    expect(cls.pooling).toBe('cls');
    expect(embedderIdentity(cls)).toBe('local:onnx-community/gte-multilingual-base');
    expect(cls.prefixes).toBe(inputPrefixes('onnx-community/gte-multilingual-base'));
  });
});

describe('from ZOTEUS_EMBEDDING_MODEL to the pipeline call', () => {
  let root: string;
  let stub: any;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'zoteus-pooling-'));
    const pkg = join(root, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
    // A stub whose extractor records the options each call is made with: the pooling is an
    // argument to that call, not to pipeline(), so this is the only place it can be seen.
    writeFileSync(
      join(pkg, 'index.cjs'),
      `const env = { cacheDir: '/stub/default/.cache' };
const calls = [];
async function pipeline(task, model, options) {
  return async (input, callOptions) => {
    const batch = Array.isArray(input) ? input : [input];
    calls.push({ model, input: batch, options: callOptions });
    return { data: new Float32Array(batch.length * 2).fill(0.5), dims: [batch.length, 2] };
  };
}
module.exports = { env, pipeline, calls };
`,
    );
    expect(resolveTransformers(root)).not.toBeNull();
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(async () => {
    const mod = await import(resolveTransformers(root)!);
    stub = mod.default ?? mod;
    stub.calls.length = 0;
  });

  const config = (env: Record<string, string>) =>
    loadConfig({
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_TRANSFORMERS_PATH: root,
      ZOTEUS_DATA_DIR: join(root, 'data'),
      ...env,
    } as any);

  it('pools a listed CLS model with cls, from the model setting alone', async () => {
    const { provider } = createEmbeddingProvider(
      config({ ZOTEUS_EMBEDDING_MODEL: 'onnx-community/gte-multilingual-base' }),
      silentLogger,
    );
    await provider!.embed(['une pompe à chaleur']);
    expect(stub.calls).toEqual([
      {
        model: 'onnx-community/gte-multilingual-base',
        input: ['une pompe à chaleur'],
        options: { pooling: 'cls', normalize: true },
      },
    ]);
  });

  it('pools the default exactly as it always was, with nothing configured', async () => {
    const { provider } = createEmbeddingProvider(config({}), silentLogger);
    await provider!.embed(['a passage']);
    expect(stub.calls).toEqual([
      { model: DEFAULT_LOCAL_MODEL, input: ['a passage'], options: { pooling: 'mean', normalize: true } },
    ]);
  });

  it('lets ZOTEUS_EMBEDDING_POOLING speak for a checkpoint the table does not know', async () => {
    const { provider } = createEmbeddingProvider(
      config({ ZOTEUS_EMBEDDING_MODEL: 'some-org/private-mirror-of-gte', ZOTEUS_EMBEDDING_POOLING: 'cls' }),
      silentLogger,
    );
    await provider!.embed(['une pompe à chaleur']);
    expect(stub.calls[0]!.options).toEqual({ pooling: 'cls', normalize: true });
  });
});

describe('ZOTEUS_EMBEDDING_POOLING as a setting', () => {
  it('reads auto, mean and cls, and defaults to auto', () => {
    expect(loadConfig({} as any).embeddingPooling).toBe('auto');
    expect(loadConfig({ ZOTEUS_EMBEDDING_POOLING: 'cls' } as any).embeddingPooling).toBe('cls');
    expect(loadConfig({ ZOTEUS_EMBEDDING_POOLING: 'mean' } as any).embeddingPooling).toBe('mean');
  });

  it('overrides the table in both directions, exactly as the prefixes setting overrides the id test', () => {
    const gte = 'onnx-community/gte-multilingual-base';
    expect(new LocalEmbeddingProvider(gte, undefined, { pooling: 'mean' }).pooling).toBe('mean');
    expect(new LocalEmbeddingProvider(DEFAULT_LOCAL_MODEL, undefined, { pooling: 'cls' }).pooling).toBe('cls');
    expect(new LocalEmbeddingProvider('some-org/unknown', undefined, { pooling: 'cls' }).pooling).toBe('cls');
    // `auto` is the table, and unset is `auto`.
    expect(new LocalEmbeddingProvider(gte, undefined, { pooling: 'auto' }).pooling).toBe('cls');
    expect(new LocalEmbeddingProvider(gte).pooling).toBe('cls');
  });

  it('falls back to the table when it is not a pooling, and says which values it takes', () => {
    // `max` and `average` are real poolings the pipeline does not have, `CLS` is the right
    // one misspelt: each is a value the user believed in, so the warning names the two
    // that exist rather than only the one that failed.
    for (const bad of ['max', 'average', 'CLS', 'yes']) {
      const cfg = loadConfig({ ZOTEUS_EMBEDDING_POOLING: bad } as any);
      expect(cfg.embeddingPooling, bad).toBe('auto');
      const warned = cfg.warnings.join(' ');
      expect(warned).toContain('ZOTEUS_EMBEDDING_POOLING');
      expect(warned).toMatch(/mean, cls/);
    }
    expect(loadConfig({ ZOTEUS_EMBEDDING_POOLING: 'cls' } as any).warnings.join(' ')).not.toMatch(
      /ZOTEUS_EMBEDDING_POOLING/,
    );
  });

  it('says it is ignored under an API provider instead of implying a choice', () => {
    const openai = loadConfig({ ZOTEUS_EMBEDDINGS: 'openai', ZOTEUS_EMBEDDING_POOLING: 'cls' } as any);
    expect(openai.warnings.join(' ')).toMatch(/ZOTEUS_EMBEDDING_POOLING applies to on-device embeddings only/);

    const local = loadConfig({ ZOTEUS_EMBEDDINGS: 'local', ZOTEUS_EMBEDDING_POOLING: 'cls' } as any);
    expect(local.warnings.join(' ')).not.toMatch(/ZOTEUS_EMBEDDING_POOLING/);
    const unset = loadConfig({ ZOTEUS_EMBEDDINGS: 'openai' } as any);
    expect(unset.warnings.join(' ')).not.toMatch(/ZOTEUS_EMBEDDING_POOLING/);
  });

  it('reads a desktop host\'s unsubstituted placeholder as "not set", not as a choice', () => {
    for (const embeddings of ['local', 'openai']) {
      const cfg = loadConfig({
        ZOTEUS_EMBEDDINGS: embeddings,
        ZOTEUS_EMBEDDING_POOLING: '${user_config.embedding_pooling}',
        ZOTEUS_DIST: 'mcpb',
      } as any);
      expect(cfg.embeddingPooling).toBe('auto');
      expect(cfg.warnings.join(' ')).not.toMatch(/ZOTEUS_EMBEDDING_POOLING/);
    }
  });
});

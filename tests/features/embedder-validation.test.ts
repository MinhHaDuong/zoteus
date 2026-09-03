import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBEDDER_VALIDATION_FIXTURE,
  InProcessLocalEmbeddingTransport,
  NORMALIZATION_TOLERANCE,
  ValidatedLocalEmbeddingProvider,
  validationCachePath,
  validateEmbeddingSelection,
  validateLocalEmbedder,
  type EmbedderRuntimeShape,
  type LocalValidationTarget,
} from '../../src/features/search/embedder-validation.js';
import {
  INCUMBENT_LOCAL_ENTRY,
  entryFingerprint,
  selectEmbedderEntry,
  type EmbedderEntry,
} from '../../src/features/search/embedder-registry.js';
import { LocalEmbeddingProvider, embedderIdentity } from '../../src/features/search/embeddings.js';

const ENTRY: EmbedderEntry = {
  id: 'fixture-entry',
  model: 'public/fixture-model',
  revision: 'a'.repeat(40),
  dtype: 'fp32',
  graphFile: 'onnx/model.onnx',
  pooling: 'mean',
  normalize: true,
  template: { query: 'query: ', passage: 'passage: ' },
  windowTokens: 512,
  dimension: 3,
  sources: Object.fromEntries(
    [
      'model',
      'revision',
      'dtype',
      'graphFile',
      'pooling',
      'normalize',
      'template',
      'windowTokens',
      'dimension',
    ].map((field) => [field, 'public fixture']),
  ),
};

const RUNTIME: EmbedderRuntimeShape = {
  engineVersion: '4.2.0',
  backendVersions: { common: '1.24.3', node: '1.24.3' },
  runtime: 'node',
  nodeVersion: '22.20.0',
  operatingSystem: 'linux',
  architecture: 'x64',
  executionProvider: 'cpu',
};

const RAW: Readonly<Record<string, number[]>> = {
  [`passage: ${EMBEDDER_VALIDATION_FIXTURE.sentinel}`]: [1, 2, 2],
  [`query: ${EMBEDDER_VALIDATION_FIXTURE.query}`]: [3, 0, 0],
  [`passage: ${EMBEDDER_VALIDATION_FIXTURE.matched}`]: [3, 0.1, 0],
  [`passage: ${EMBEDDER_VALIDATION_FIXTURE.unmatched}`]: [0, 3, 0],
};

function normalized(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

interface Mutants {
  shape?: boolean;
  nonFinite?: boolean;
  notNormalized?: boolean;
  nondeterministic?: boolean;
  nondeterministicPublic?: boolean;
  ignoreTemplate?: boolean;
  reverseDiscrimination?: boolean;
  batchSensitive?: boolean;
}

class FixtureTarget implements LocalValidationTarget {
  readonly name = 'local';
  readonly model: string;
  readonly entryId: string;
  readonly vectorFingerprint: string;
  readonly legacyIdentity: boolean;
  readonly entry: EmbedderEntry;
  preparedCalls = 0;
  publicCalls = 0;

  constructor(
    readonly runtimeShape: EmbedderRuntimeShape = RUNTIME,
    fingerprint?: string,
    private readonly mutants: Mutants = {},
    legacyIdentity = false,
    entry: EmbedderEntry = ENTRY,
  ) {
    this.entry = entry;
    this.model = entry.model;
    this.entryId = entry.id;
    this.vectorFingerprint = fingerprint ?? entryFingerprint(entry);
    this.legacyIdentity = legacyIdentity;
  }

  private vectors(texts: string[], normalize: boolean): number[][] {
    let vectors = texts.map((text) => [...(RAW[text] ?? [0.2, 0.3, 0.4])]);
    if (this.mutants.reverseDiscrimination) {
      vectors = texts.map((text, index) =>
        text.includes(EMBEDDER_VALIDATION_FIXTURE.matched)
          ? [0, 3, 0]
          : text.includes(EMBEDDER_VALIDATION_FIXTURE.unmatched)
            ? [3, 0.1, 0]
            : vectors[index]!,
      );
    }
    if (this.mutants.batchSensitive) {
      vectors = vectors.map((vector) => [vector[0]!, vector[1]!, vector[2]! + texts.length / 10]);
    }
    return normalize ? vectors.map(normalized) : vectors;
  }

  async validationRuntimeShape(): Promise<EmbedderRuntimeShape> {
    return this.runtimeShape;
  }

  async embedPreparedForValidation(texts: string[], normalize: boolean): Promise<number[][]> {
    this.preparedCalls++;
    const vectors = this.vectors(texts, normalize);
    if (this.mutants.nondeterministic && this.preparedCalls === 2) vectors[0]![0]! += 0.01;
    if (normalize && this.mutants.notNormalized) vectors[0] = [1, 1, 1];
    if (this.mutants.nonFinite) vectors[0]![0] = Number.NaN;
    if (this.mutants.shape) vectors[0]!.pop();
    return vectors;
  }

  async embed(texts: string[], role: 'query' | 'passage' = 'passage'): Promise<number[][]> {
    this.publicCalls++;
    const prefix = this.mutants.ignoreTemplate ? '' : this.entry.template[role];
    const vectors = this.vectors(
      texts.map((text) => `${prefix}${text}`),
      true,
    );
    if (this.mutants.nondeterministicPublic && this.publicCalls === 2) {
      vectors[0]![0]! += 0.01;
    }
    return vectors;
  }
}

describe('local embedder compatibility validation', () => {
  it('passes the public fixture and records only a content-free atomic PASS', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-validation-'));
    const target = new FixtureTarget();
    const result = await validateLocalEmbedder(target, dataDir);

    expect(result.status).toBe('passed');
    expect(result.cached).toBe(false);
    expect(target.preparedCalls).toBeGreaterThan(0);
    expect(target.publicCalls).toBeGreaterThan(0);
    const path = validationCachePath(dataDir, result.key);
    const saved = readFileSync(path, 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ status: 'passed', key: result.key });
    expect(saved).not.toContain(EMBEDDER_VALIDATION_FIXTURE.query);
    expect(saved).not.toContain('score');
    expect(
      readdirSync(join(dataDir, 'embedder-validation')).filter((name) => name.includes('.tmp')),
    ).toEqual([]);
  });

  it('uses an exact cache key and skips model calls only for an exact PASS', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-validation-cache-'));
    const first = new FixtureTarget();
    const pass = await validateLocalEmbedder(first, dataDir);
    expect(first.preparedCalls).toBeGreaterThan(0);

    const same = new FixtureTarget();
    const cached = await validateLocalEmbedder(same, dataDir);
    expect(cached).toMatchObject({ key: pass.key, cached: true, status: 'passed' });
    expect(same.preparedCalls).toBe(0);
    expect(same.publicCalls).toBe(0);

    const changedShapes: EmbedderRuntimeShape[] = [
      { ...RUNTIME, engineVersion: '4.2.1' },
      { ...RUNTIME, backendVersions: { ...RUNTIME.backendVersions, node: '1.24.4' } },
      { ...RUNTIME, runtime: 'electron', electronVersion: '40.0.0' },
      { ...RUNTIME, nodeVersion: '22.21.0' },
      { ...RUNTIME, operatingSystem: 'darwin' },
      { ...RUNTIME, architecture: 'arm64' },
      { ...RUNTIME, executionProvider: 'cuda' },
    ];
    for (const runtime of changedShapes) {
      const changed = new FixtureTarget(runtime);
      const result = await validateLocalEmbedder(changed, dataDir);
      expect(result.cached).toBe(false);
      expect(changed.preparedCalls).toBeGreaterThan(0);
    }
    const changedEntry = { ...ENTRY, revision: 'b'.repeat(40) };
    const changedFingerprint = new FixtureTarget(RUNTIME, undefined, {}, false, changedEntry);
    expect((await validateLocalEmbedder(changedFingerprint, dataDir)).cached).toBe(false);

    const electron = { ...RUNTIME, runtime: 'electron' as const, electronVersion: '40.0.0' };
    const electronPass = await validateLocalEmbedder(new FixtureTarget(electron), dataDir);
    const changedElectron = await validateLocalEmbedder(
      new FixtureTarget({ ...electron, electronVersion: '41.0.0' }),
      dataDir,
    );
    expect(changedElectron.key).not.toBe(electronPass.key);
    expect(changedElectron.cached).toBe(false);
  });

  it('ignores a malformed or widened cache record', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-validation-malformed-'));
    const first = new FixtureTarget();
    const result = await validateLocalEmbedder(first, dataDir);
    const path = validationCachePath(dataDir, result.key);
    writeFileSync(path, JSON.stringify({ status: 'passed', key: result.key, surprise: true }));

    const next = new FixtureTarget();
    expect((await validateLocalEmbedder(next, dataDir)).cached).toBe(false);
    expect(next.preparedCalls).toBeGreaterThan(0);
  });

  it('rejects a claimed fingerprint that does not match the complete entry before cache lookup', async () => {
    const target = new FixtureTarget(RUNTIME, 'e'.repeat(64));
    await expect(
      validateLocalEmbedder(target, mkdtempSync(join(tmpdir(), 'zoteus-validation-fingerprint-'))),
    ).rejects.toThrow(/fingerprint.*complete registry entry/i);
    expect(target.preparedCalls).toBe(0);
    expect(target.publicCalls).toBe(0);
  });

  it.each([
    ['wrong shape', { shape: true }, /shape|dimension/i],
    ['non-finite output', { nonFinite: true }, /finite/i],
    ['normalization disabled', { notNormalized: true }, /normaliz/i],
    ['nondeterminism', { nondeterministic: true }, /determin/i],
    ['public nondeterminism', { nondeterministicPublic: true }, /determin/i],
    ['template bypass', { ignoreTemplate: true }, /template/i],
    ['reversed discrimination', { reverseDiscrimination: true }, /matched|discrimin/i],
  ] as const)('rejects the %s mutant and does not cache it', async (_name, mutant, error) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-validation-mutant-'));
    const target = new FixtureTarget(RUNTIME, undefined, mutant);
    await expect(validateLocalEmbedder(target, dataDir)).rejects.toThrow(error);
    expect(
      readdirSync(dataDir, { recursive: true }).filter((name) => String(name).endsWith('.json')),
    ).toEqual([]);
  });

  it('uses the ratified L2 tolerance', () => {
    expect(NORMALIZATION_TOLERANCE).toBe(0.00001);
  });

  it('compares exact outputs only at identical batch shapes', async () => {
    const target = new FixtureTarget(RUNTIME, undefined, { batchSensitive: true });
    await expect(
      validateLocalEmbedder(target, mkdtempSync(join(tmpdir(), 'zoteus-validation-batch-'))),
    ).resolves.toMatchObject({ status: 'passed', cached: false });
  });

  it('does not run the local fixture or write cache state for an API provider', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-api-validation-'));
    const provider = { name: 'openai', model: 'api-model', embed: async () => [[1, 0, 0]] };
    const selection = { provider, configured: 'openai' as const };
    await expect(validateEmbeddingSelection(selection, dataDir)).resolves.toBe(selection);
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('does not invent an execution provider for an injected extractor', async () => {
    const extractor = async (texts: string[]) => ({
      data: new Float32Array(texts.length * ENTRY.dimension),
      dims: [texts.length, ENTRY.dimension],
    });
    extractor.tokenizer = { model_max_length: ENTRY.windowTokens };
    const provider = new LocalEmbeddingProvider(ENTRY, async () => extractor);
    await expect(provider.validationRuntimeShape()).rejects.toThrow(/must declare.*runtime/i);
  });

  it('validates the real provider seam and fails closed without choosing another entry', async () => {
    const extractor = async (texts: string[], options: { normalize: boolean }) => {
      const rows = texts.map((text) => [...(RAW[text] ?? [0.2, 0.3, 0.4])]);
      const vectors = options.normalize ? rows.map(normalized) : rows;
      return { data: new Float32Array(vectors.flat()), dims: [vectors.length, ENTRY.dimension] };
    };
    extractor.tokenizer = { model_max_length: ENTRY.windowTokens };
    const provider = new LocalEmbeddingProvider(ENTRY, async () => extractor, {
      validationRuntime: RUNTIME,
    });
    const selection = await validateEmbeddingSelection(
      { provider, configured: 'local' },
      mkdtempSync(join(tmpdir(), 'zoteus-selection-')),
    );
    expect(selection.provider).toBeInstanceOf(ValidatedLocalEmbeddingProvider);
    expect(selection.provider?.entryId).toBe(ENTRY.id);

    const brokenExtractor = async (texts: string[]) => ({
      data: new Float32Array(texts.length * 2),
      dims: [texts.length, 2],
    });
    brokenExtractor.tokenizer = { model_max_length: ENTRY.windowTokens };
    const broken = new LocalEmbeddingProvider(ENTRY, async () => brokenExtractor, {
      validationRuntime: RUNTIME,
    });
    const failed = await validateEmbeddingSelection(
      { provider: broken, configured: 'local' },
      mkdtempSync(join(tmpdir(), 'zoteus-selection-fail-')),
    );
    expect(failed.provider).toBeNull();
    expect(failed.unavailable).toMatch(/validation failed/i);
    expect(failed.unavailable).toContain(ENTRY.id);
  });

  const realRuntimeIt =
    process.env.ZOTEUS_TRANSFORMERS_PATH && process.env.ZOTEUS_TEST_MODEL_CACHE_DIR ? it : it.skip;
  realRuntimeIt(
    'passes through the production provider and a real cached Transformers.js model',
    async () => {
      const provider = new LocalEmbeddingProvider(undefined, undefined, {
        transformersPath: process.env.ZOTEUS_TRANSFORMERS_PATH,
        modelCacheDir: process.env.ZOTEUS_TEST_MODEL_CACHE_DIR,
      });
      const result = await validateLocalEmbedder(
        provider,
        mkdtempSync(join(tmpdir(), 'zoteus-real-validation-')),
      );
      expect(result).toMatchObject({
        status: 'passed',
        cached: false,
        entryFingerprint: provider.vectorFingerprint,
        dimension: provider.entry.dimension,
      });
      expect(result.runtime.engineVersion).toMatch(/^4\./);
      expect(result.runtime.executionProvider).toBe('cpu');
    },
    30_000,
  );

  const realE5It =
    process.env.ZOTEUS_TRANSFORMERS_PATH && process.env.ZOTEUS_TEST_E5_Q8_CACHE_DIR ? it : it.skip;
  realE5It(
    'passes the batch-sensitive E5 q8 registry entry without weakening exact comparison',
    async () => {
      const provider = new LocalEmbeddingProvider(
        selectEmbedderEntry('multilingual-e5-small-q8'),
        undefined,
        {
          transformersPath: process.env.ZOTEUS_TRANSFORMERS_PATH,
          modelCacheDir: process.env.ZOTEUS_TEST_E5_Q8_CACHE_DIR,
        },
      );
      await expect(
        validateLocalEmbedder(provider, mkdtempSync(join(tmpdir(), 'zoteus-real-e5-q8-'))),
      ).resolves.toMatchObject({
        status: 'passed',
        cached: false,
        entryFingerprint: provider.vectorFingerprint,
        dimension: 384,
      });
    },
    30_000,
  );
});

describe('validated local embedding transport', () => {
  it('preserves vector identity and accepts the exact validated handshake', async () => {
    const target = new FixtureTarget(RUNTIME, undefined, {}, true);
    const result = await validateLocalEmbedder(
      target,
      mkdtempSync(join(tmpdir(), 'zoteus-transport-')),
    );
    const provider = new ValidatedLocalEmbeddingProvider(
      target,
      result,
      new InProcessLocalEmbeddingTransport(target, result),
    );
    expect(provider).toMatchObject({
      name: target.name,
      model: target.model,
      entryId: target.entryId,
      vectorFingerprint: target.vectorFingerprint,
      legacyIdentity: false,
    });
    expect(embedderIdentity(provider)).toBe(`local:registry-v${entryFingerprint(ENTRY)}`);
    expect(await provider.embed([EMBEDDER_VALIDATION_FIXTURE.query], 'query')).toHaveLength(1);
  });

  it('derives the incumbent legacy identity from its verified fingerprint, not a claim', () => {
    const fingerprint = entryFingerprint(INCUMBENT_LOCAL_ENTRY);
    const target: LocalValidationTarget = {
      name: 'local',
      model: INCUMBENT_LOCAL_ENTRY.model,
      entryId: INCUMBENT_LOCAL_ENTRY.id,
      entry: INCUMBENT_LOCAL_ENTRY,
      vectorFingerprint: fingerprint,
      legacyIdentity: false,
      validationRuntimeShape: async () => RUNTIME,
      embedPreparedForValidation: async () => [],
      embed: async () => [],
    };
    const validation = {
      status: 'passed' as const,
      key: 'a'.repeat(64),
      entryFingerprint: fingerprint,
      dimension: INCUMBENT_LOCAL_ENTRY.dimension,
      runtime: RUNTIME,
      cached: false,
    };
    const provider = new ValidatedLocalEmbeddingProvider(target, validation, {
      embed: async () => {
        throw new Error('not called');
      },
    });
    expect(provider.legacyIdentity).toBe(true);
    expect(embedderIdentity(provider)).toBe(`local:${INCUMBENT_LOCAL_ENTRY.model}`);
  });

  it.each(['fingerprint', 'validationKey', 'dimension', 'runtime'] as const)(
    'rejects a mismatched daemon %s before exposing vectors',
    async (field) => {
      const target = new FixtureTarget();
      const result = await validateLocalEmbedder(
        target,
        mkdtempSync(join(tmpdir(), 'zoteus-client-')),
      );
      const good = new InProcessLocalEmbeddingTransport(target, result);
      const transport = {
        embed: async (request: any) => {
          const reply: any = await good.embed(request);
          if (field === 'fingerprint') reply.actualFingerprint = '0'.repeat(64);
          if (field === 'validationKey') reply.validationKey = '0'.repeat(64);
          if (field === 'dimension') reply.dimension++;
          if (field === 'runtime') reply.runtime = { ...reply.runtime, executionProvider: 'cuda' };
          return reply;
        },
      };
      const provider = new ValidatedLocalEmbeddingProvider(target, result, transport);
      await expect(provider.embed(['anything'])).rejects.toThrow(/mismatch/i);
    },
  );

  it('has the in-process daemon reject a stale request before inference', async () => {
    const target = new FixtureTarget();
    const result = await validateLocalEmbedder(
      target,
      mkdtempSync(join(tmpdir(), 'zoteus-daemon-')),
    );
    const transport = new InProcessLocalEmbeddingTransport(target, result);
    const calls = target.publicCalls;
    await expect(
      transport.embed({
        requestedFingerprint: target.vectorFingerprint,
        validationKey: '0'.repeat(64),
        expectedDimension: target.entry.dimension,
        texts: ['anything'],
        role: 'passage',
      }),
    ).rejects.toThrow(/stale|mismatch/i);
    expect(target.publicCalls).toBe(calls);
  });

  it('has the in-process daemon reject a changed runtime before inference', async () => {
    const target = new FixtureTarget();
    const result = await validateLocalEmbedder(
      target,
      mkdtempSync(join(tmpdir(), 'zoteus-daemon-runtime-')),
    );
    const transport = new InProcessLocalEmbeddingTransport(target, result);
    (target as { runtimeShape: EmbedderRuntimeShape }).runtimeShape = {
      ...RUNTIME,
      executionProvider: 'cuda',
    };
    const calls = target.publicCalls;
    await expect(
      transport.embed({
        requestedFingerprint: target.vectorFingerprint,
        validationKey: result.key,
        expectedDimension: target.entry.dimension,
        texts: ['anything'],
        role: 'passage',
      }),
    ).rejects.toThrow(/stale|mismatch/i);
    expect(target.publicCalls).toBe(calls);
  });
});

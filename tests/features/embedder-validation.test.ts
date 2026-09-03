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
import type { EmbedderEntry } from '../../src/features/search/embedder-registry.js';
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
  ignoreTemplate?: boolean;
  reverseDiscrimination?: boolean;
}

class FixtureTarget implements LocalValidationTarget {
  readonly name = 'local';
  readonly model = ENTRY.model;
  readonly entryId = ENTRY.id;
  readonly vectorFingerprint: string;
  readonly legacyIdentity: boolean;
  readonly entry = ENTRY;
  preparedCalls = 0;
  publicCalls = 0;

  constructor(
    readonly runtimeShape: EmbedderRuntimeShape = RUNTIME,
    fingerprint = 'f'.repeat(64),
    private readonly mutants: Mutants = {},
    legacyIdentity = false,
  ) {
    this.vectorFingerprint = fingerprint;
    this.legacyIdentity = legacyIdentity;
  }

  async validationRuntimeShape(): Promise<EmbedderRuntimeShape> {
    return this.runtimeShape;
  }

  async embedPreparedForValidation(texts: string[], normalize: boolean): Promise<number[][]> {
    this.preparedCalls++;
    let vectors = texts.map((text) => [...(RAW[text] ?? [0.2, 0.3, 0.4])]);
    if (this.mutants.reverseDiscrimination) {
      vectors = vectors.map((vector, index) =>
        index === 2 ? [0, 3, 0] : index === 3 ? [3, 0.1, 0] : vector,
      );
    }
    if (this.mutants.nondeterministic && this.preparedCalls === 2) vectors[0]![0]! += 0.01;
    if (normalize) vectors = vectors.map(normalized);
    if (normalize && this.mutants.notNormalized) vectors[0] = [1, 1, 1];
    if (this.mutants.nonFinite) vectors[0]![0] = Number.NaN;
    if (this.mutants.shape) vectors[0]!.pop();
    return vectors;
  }

  async embed(texts: string[], role: 'query' | 'passage' = 'passage'): Promise<number[][]> {
    this.publicCalls++;
    const prefix = this.mutants.ignoreTemplate ? '' : ENTRY.template[role];
    let vectors = texts.map((text) => [...(RAW[`${prefix}${text}`] ?? [0.2, 0.3, 0.4])]);
    if (this.mutants.reverseDiscrimination && role === 'passage') {
      vectors = vectors.map((vector, index) =>
        index === 1 ? [0, 3, 0] : index === 2 ? [3, 0.1, 0] : vector,
      );
    }
    return vectors.map(normalized);
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
    const changedFingerprint = new FixtureTarget(RUNTIME, 'e'.repeat(64));
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

  it.each([
    ['wrong shape', { shape: true }, /shape|dimension/i],
    ['non-finite output', { nonFinite: true }, /finite/i],
    ['normalization disabled', { notNormalized: true }, /normaliz/i],
    ['nondeterminism', { nondeterministic: true }, /determin/i],
    ['template bypass', { ignoreTemplate: true }, /template/i],
    ['reversed discrimination', { reverseDiscrimination: true }, /matched|discrimin/i],
  ] as const)('rejects the %s mutant and does not cache it', async (_name, mutant, error) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-validation-mutant-'));
    const target = new FixtureTarget(RUNTIME, 'f'.repeat(64), mutant);
    await expect(validateLocalEmbedder(target, dataDir)).rejects.toThrow(error);
    expect(
      readdirSync(dataDir, { recursive: true }).filter((name) => String(name).endsWith('.json')),
    ).toEqual([]);
  });

  it('uses the ratified L2 tolerance', () => {
    expect(NORMALIZATION_TOLERANCE).toBe(0.00001);
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
});

describe('validated local embedding transport', () => {
  it('preserves vector identity and accepts the exact validated handshake', async () => {
    const target = new FixtureTarget(RUNTIME, 'f'.repeat(64), {}, true);
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
      legacyIdentity: target.legacyIdentity,
    });
    expect(embedderIdentity(provider)).toBe(`local:${ENTRY.model}`);
    expect(await provider.embed([EMBEDDER_VALIDATION_FIXTURE.query], 'query')).toHaveLength(1);
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

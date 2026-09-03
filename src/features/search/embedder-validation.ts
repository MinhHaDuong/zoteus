import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EmbedderEntry } from './embedder-registry.js';
import type { EmbedderSelection, EmbeddingProvider } from './embeddings.js';
import type { Logger } from '../../lib/logger.js';

/** Ratified local compatibility bound: |L2 norm - 1| must not exceed this value. */
export const NORMALIZATION_TOLERANCE = 0.00001;

/** Bump whenever the meaning or implementation of a fixture check changes. */
export const EMBEDDER_VALIDATOR_REVISION = 'local-compatibility/1';

/**
 * Public, non-library text used only to prove that a selected vector chain executes as
 * declared. This is deliberately small and technical: it is a compatibility fixture, not
 * a retrieval-quality ballot.
 */
export const EMBEDDER_VALIDATION_FIXTURE = Object.freeze({
  sentinel: 'A prism separates white light into a spectrum of colors.',
  query: 'How do plants store energy from sunlight?',
  matched: 'Photosynthesis converts sunlight into chemical energy stored in sugars.',
  unmatched: 'Tectonic plates move slowly and can generate earthquakes.',
});

export interface EmbedderRuntimeShape {
  /** @huggingface/transformers version. */
  readonly engineVersion: string;
  /** The ONNX Runtime versions wired into that exact Transformers.js module. */
  readonly backendVersions: Readonly<Record<string, string>>;
  readonly runtime: 'node' | 'electron';
  readonly nodeVersion: string;
  readonly electronVersion?: string;
  readonly operatingSystem: string;
  readonly architecture: string;
  /** Concrete provider that ran the fixture; never a request such as "auto". */
  readonly executionProvider: string;
}

/** The narrow validation seam a local runtime must expose; it is also the future daemon seam. */
export interface LocalValidationTarget extends EmbeddingProvider {
  readonly entry: EmbedderEntry;
  readonly vectorFingerprint: string;
  readonly legacyIdentity?: boolean;
  validationRuntimeShape(): Promise<EmbedderRuntimeShape>;
  /** Run already-templated strings, allowing the fixture to verify the public role wrapper. */
  embedPreparedForValidation(texts: string[], normalize: boolean): Promise<number[][]>;
}

export interface LocalValidationResult {
  readonly status: 'passed';
  /** Hash of the full entry + fixture + environment tuple. */
  readonly key: string;
  readonly entryFingerprint: string;
  readonly dimension: number;
  readonly runtime: EmbedderRuntimeShape;
  readonly cached: boolean;
}

const CACHE_DIRECTORY = 'embedder-validation';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizedRuntimeShape(shape: EmbedderRuntimeShape): EmbedderRuntimeShape {
  const backendVersions = Object.fromEntries(
    Object.entries(shape.backendVersions).sort(([left], [right]) => left.localeCompare(right)),
  );
  const normalized: EmbedderRuntimeShape = {
    engineVersion: shape.engineVersion,
    backendVersions,
    runtime: shape.runtime,
    nodeVersion: shape.nodeVersion,
    operatingSystem: shape.operatingSystem,
    architecture: shape.architecture,
    executionProvider: shape.executionProvider,
    ...(shape.electronVersion === undefined ? {} : { electronVersion: shape.electronVersion }),
  };
  for (const [field, value] of Object.entries(normalized)) {
    if (field === 'backendVersions') continue;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Local embedder runtime field ${field} is missing.`);
    }
  }
  if (Object.keys(backendVersions).length === 0) {
    throw new Error('Local embedder runtime reported no ONNX Runtime version.');
  }
  for (const [name, version] of Object.entries(backendVersions)) {
    if (!name || !version)
      throw new Error('Local embedder runtime reported an invalid backend version.');
  }
  if (normalized.runtime === 'electron' && !normalized.electronVersion) {
    throw new Error('Local embedder Electron runtime reported no Electron version.');
  }
  if (normalized.runtime === 'node' && normalized.electronVersion) {
    throw new Error('Local embedder Node runtime unexpectedly reported an Electron version.');
  }
  if (normalized.executionProvider === 'auto') {
    throw new Error('Local embedder runtime reported an unresolved execution provider "auto".');
  }
  return Object.freeze({ ...normalized, backendVersions: Object.freeze(backendVersions) });
}

function validationKey(target: LocalValidationTarget, runtime: EmbedderRuntimeShape): string {
  // Include the fixture and its rule so a corrected validator cannot inherit an old PASS.
  const fixture = sha256({
    validatorRevision: EMBEDDER_VALIDATOR_REVISION,
    texts: EMBEDDER_VALIDATION_FIXTURE,
    normalizationTolerance: NORMALIZATION_TOLERANCE,
    discrimination: 'matched>unmatched',
    checks: ['load', 'shape', 'finite', 'normalization', 'templates', 'determinism'],
  });
  return sha256({
    entryFingerprint: target.vectorFingerprint,
    fixture,
    engineVersion: runtime.engineVersion,
    backendVersions: runtime.backendVersions,
    runtime: runtime.runtime,
    nodeVersion: runtime.nodeVersion,
    electronVersion: runtime.electronVersion ?? null,
    operatingSystem: runtime.operatingSystem,
    architecture: runtime.architecture,
    executionProvider: runtime.executionProvider,
  });
}

export function validationCachePath(dataDir: string, key: string): string {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid local embedder validation key.');
  return join(dataDir, CACHE_DIRECTORY, `${key}.json`);
}

function exactPassRecord(value: unknown, key: string): boolean {
  return canonical(value) === canonical({ status: 'passed', key });
}

async function hasCachedPass(dataDir: string, key: string): Promise<boolean> {
  try {
    return exactPassRecord(
      JSON.parse(await readFile(validationCachePath(dataDir, key), 'utf8')),
      key,
    );
  } catch {
    return false;
  }
}

async function storePass(dataDir: string, key: string): Promise<void> {
  const dir = join(dataDir, CACHE_DIRECTORY);
  await mkdir(dir, { recursive: true });
  const destination = validationCachePath(dataDir, key);
  const temporary = join(dir, `.${key}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ status: 'passed', key })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, destination);
  } catch (error) {
    // Two processes may validate the same entry together. A complete exact PASS written
    // by the winner is equivalent to ours; anything else remains an error.
    if (!(await hasCachedPass(dataDir, key))) throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function checkVectors(label: string, vectors: number[][], count: number, dimension: number): void {
  if (vectors.length !== count) {
    throw new Error(`${label} produced ${vectors.length} vectors; expected ${count}.`);
  }
  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== dimension) {
      throw new Error(
        `${label} vector ${index} has dimension ${vector.length}; expected ${dimension}.`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`${label} vector ${index} contains a non-finite value.`);
    }
  }
}

function vectorsAreExact(left: number[][], right: number[][]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (vector, row) =>
        vector.length === right[row]?.length &&
        vector.every((value, column) => Object.is(value, right[row]![column])),
    )
  );
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftSquared += left[index]! ** 2;
    rightSquared += right[index]! ** 2;
  }
  return dot / Math.sqrt(leftSquared * rightSquared);
}

async function runFixture(target: LocalValidationTarget): Promise<void> {
  const fixture = EMBEDDER_VALIDATION_FIXTURE;
  const prepared = [
    `${target.entry.template.passage}${fixture.sentinel}`,
    `${target.entry.template.query}${fixture.query}`,
    `${target.entry.template.passage}${fixture.matched}`,
    `${target.entry.template.passage}${fixture.unmatched}`,
  ];
  const rawFirst = await target.embedPreparedForValidation(prepared, false);
  const rawSecond = await target.embedPreparedForValidation(prepared, false);
  const normalized = await target.embedPreparedForValidation(prepared, true);
  const query = await target.embed([fixture.query], 'query');
  const passages = await target.embed(
    [fixture.sentinel, fixture.matched, fixture.unmatched],
    'passage',
  );
  const dimension = target.entry.dimension;
  checkVectors('Unnormalized fixture', rawFirst, prepared.length, dimension);
  checkVectors('Repeated unnormalized fixture', rawSecond, prepared.length, dimension);
  checkVectors('Normalized fixture', normalized, prepared.length, dimension);
  checkVectors('Query-template fixture', query, 1, dimension);
  checkVectors('Passage-template fixture', passages, 3, dimension);

  if (!vectorsAreExact(rawFirst, rawSecond)) {
    throw new Error('Local embedder is not deterministic within this execution provider.');
  }
  for (const [index, vector] of normalized.entries()) {
    const norm = Math.hypot(...vector);
    if (Math.abs(norm - 1) > NORMALIZATION_TOLERANCE) {
      throw new Error(
        `Local embedder normalization failed for fixture vector ${index}: L2 norm ${norm}.`,
      );
    }
  }

  const selected = target.entry.normalize ? normalized : rawFirst;
  if (!vectorsAreExact(query, [selected[1]!])) {
    throw new Error('Local embedder did not apply the declared query template and normalization.');
  }
  if (!vectorsAreExact(passages, [selected[0]!, selected[2]!, selected[3]!])) {
    throw new Error(
      'Local embedder did not apply the declared passage template and normalization.',
    );
  }

  const matched = cosine(query[0]!, passages[1]!);
  const unmatched = cosine(query[0]!, passages[2]!);
  if (!Number.isFinite(matched) || !Number.isFinite(unmatched) || !(matched > unmatched)) {
    throw new Error('Local embedder failed matched-over-unmatched fixture discrimination.');
  }
}

/** Validate one exact local entry in one exact environment, or reuse only its exact PASS. */
export async function validateLocalEmbedder(
  target: LocalValidationTarget,
  dataDir: string,
): Promise<LocalValidationResult> {
  const runtime = normalizedRuntimeShape(await target.validationRuntimeShape());
  const key = validationKey(target, runtime);
  const base = {
    status: 'passed' as const,
    key,
    entryFingerprint: target.vectorFingerprint,
    dimension: target.entry.dimension,
    runtime,
  };
  if (await hasCachedPass(dataDir, key)) return Object.freeze({ ...base, cached: true });
  await runFixture(target);
  await storePass(dataDir, key);
  return Object.freeze({ ...base, cached: false });
}

export interface LocalEmbedRequest {
  readonly requestedFingerprint: string;
  readonly validationKey: string;
  readonly expectedDimension: number;
  readonly texts: string[];
  readonly role: 'query' | 'passage';
}

export interface LocalEmbedReply {
  readonly requestedFingerprint: string;
  readonly actualFingerprint: string;
  readonly validationKey: string;
  readonly validation: 'passed';
  readonly dimension: number;
  readonly runtime: EmbedderRuntimeShape;
  readonly vectors: number[][];
}

export interface LocalEmbeddingTransport {
  embed(request: LocalEmbedRequest): Promise<LocalEmbedReply>;
}

/** The default transport. A future daemon implements this same request/reply contract. */
export class InProcessLocalEmbeddingTransport implements LocalEmbeddingTransport {
  constructor(
    private readonly target: LocalValidationTarget,
    private readonly validation: LocalValidationResult,
  ) {}

  async embed(request: LocalEmbedRequest): Promise<LocalEmbedReply> {
    const currentRuntime = normalizedRuntimeShape(await this.target.validationRuntimeShape());
    if (
      request.requestedFingerprint !== this.target.vectorFingerprint ||
      request.requestedFingerprint !== this.validation.entryFingerprint ||
      request.validationKey !== this.validation.key ||
      request.expectedDimension !== this.validation.dimension ||
      this.target.entry.dimension !== this.validation.dimension ||
      canonical(currentRuntime) !== canonical(this.validation.runtime)
    ) {
      throw new Error('Local embedding request has a stale or mismatched validation handshake.');
    }
    const vectors = await this.target.embed(request.texts, request.role);
    return {
      requestedFingerprint: request.requestedFingerprint,
      actualFingerprint: this.target.vectorFingerprint,
      validationKey: this.validation.key,
      validation: 'passed',
      dimension: this.target.entry.dimension,
      runtime: this.validation.runtime,
      vectors,
    };
  }
}

/** Client-side guard: no vector crosses this seam without the exact validated handshake. */
export class ValidatedLocalEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model?: string;
  readonly entryId?: string;
  readonly vectorFingerprint: string;
  readonly legacyIdentity: boolean;

  constructor(
    private readonly target: LocalValidationTarget,
    readonly validation: LocalValidationResult,
    private readonly transport: LocalEmbeddingTransport,
  ) {
    this.name = target.name;
    this.model = target.model;
    this.entryId = target.entryId;
    this.vectorFingerprint = target.vectorFingerprint;
    this.legacyIdentity = target.legacyIdentity ?? false;
  }

  async embed(texts: string[], role: 'query' | 'passage' = 'passage'): Promise<number[][]> {
    const reply = await this.transport.embed({
      requestedFingerprint: this.vectorFingerprint,
      validationKey: this.validation.key,
      expectedDimension: this.validation.dimension,
      texts,
      role,
    });
    const mismatch =
      reply.requestedFingerprint !== this.vectorFingerprint ||
      reply.actualFingerprint !== this.vectorFingerprint ||
      reply.validationKey !== this.validation.key ||
      reply.validation !== 'passed' ||
      reply.dimension !== this.validation.dimension ||
      canonical(reply.runtime) !== canonical(this.validation.runtime);
    if (mismatch)
      throw new Error('Local embedding response has a mismatched validation handshake.');
    checkVectors('Validated embedding response', reply.vectors, texts.length, reply.dimension);
    return reply.vectors;
  }
}

function isLocalValidationTarget(provider: EmbeddingProvider): provider is LocalValidationTarget {
  const candidate = provider as Partial<LocalValidationTarget>;
  return (
    provider.name === 'local' &&
    typeof candidate.vectorFingerprint === 'string' &&
    typeof candidate.validationRuntimeShape === 'function' &&
    typeof candidate.embedPreparedForValidation === 'function' &&
    Boolean(candidate.entry)
  );
}

/**
 * Validate a selected local entry before an index is opened. Failure is explicit and
 * degrades to keyword-only; it never substitutes a different local entry.
 */
export async function validateEmbeddingSelection(
  selection: EmbedderSelection,
  dataDir: string,
  logger?: Logger,
): Promise<EmbedderSelection> {
  if (!selection.provider || selection.configured !== 'local') return selection;
  if (!isLocalValidationTarget(selection.provider)) {
    const unavailable =
      'Local embedder validation failed: the selected provider exposes no validation seam.';
    logger?.warn(`${unavailable} Semantic ranking is off; keyword search still works.`);
    return { provider: null, configured: selection.configured, unavailable };
  }
  try {
    const result = await validateLocalEmbedder(selection.provider, dataDir);
    return {
      ...selection,
      provider: new ValidatedLocalEmbeddingProvider(
        selection.provider,
        result,
        new InProcessLocalEmbeddingTransport(selection.provider, result),
      ),
    };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const unavailable = `Local embedder validation failed: ${cause}`;
    logger?.warn(`${unavailable} Semantic ranking is off; keyword search still works.`);
    return { provider: null, configured: selection.configured, unavailable };
  }
}

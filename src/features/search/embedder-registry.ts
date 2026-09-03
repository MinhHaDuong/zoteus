/**
 * The curated embedder registry.
 *
 * A local embedder is not a model name. It is a model *plus* the handful of choices that
 * decide what its vectors mean: which revision of the weights, which graph and numeric
 * type, how token states are pooled, whether the result is normalized, what prefixes the
 * text carries, how much of the text survives tokenization, and how wide the vector is.
 * Change any one of them and the vectors move, silently and without an error — the index
 * still loads, the search still answers, and the answers are worse. Naming only the model
 * would therefore permit configurations that load and produce the wrong vectors.
 *
 * So the configuration lives here, in one place, as one record per embedder, rather than
 * spread across a constructor default, a call-site literal and a runtime default nobody
 * wrote down. The default remains the MiniLM chain zoteus has always used. The other
 * records are pinned combinations that the measurement campaign actually exercised.
 *
 * Every vector field is authoritative: it either drives the runtime or is validated
 * against the runtime seam that drives it, and all of them enter the fingerprint. The
 * characterization and authority tests keep a declared field from becoming a silent
 * no-op, because such a field reads as a guarantee while producing another vector chain.
 */

/** Shape version of {@link EmbedderEntry}. Bump when a field is added, dropped, or re-meant. */
import { createHash } from 'node:crypto';

export const EMBEDDER_REGISTRY_VERSION = 1;

/**
 * Compatibility version serialized into vector fingerprints. This is deliberately
 * independent of {@link EMBEDDER_REGISTRY_VERSION}: changing how registry records are
 * represented must not invalidate vectors when their vector-affecting fields are unchanged.
 */
export const EMBEDDER_FINGERPRINT_VERSION = 1;

/** Pooling strategies @huggingface/transformers exposes for feature extraction. */
export type EmbedderPooling = 'mean' | 'cls' | 'last_token';

/** Numeric type of the ONNX graph that is loaded. */
export type EmbedderDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'q4f16' | 'bnb4';

/** Prefixes an embedder wants in front of a query and in front of a passage. */
export interface EmbedderTemplate {
  readonly query: string;
  readonly passage: string;
}

/** One embedder, completely described. */
export interface EmbedderEntry {
  /** Stable name for this record. Never a model name: two records can share a model. */
  readonly id: string;
  /** Repository the weights come from. */
  readonly model: string;
  /** Revision of that repository. */
  readonly revision: string;
  /** Numeric type of the graph. */
  readonly dtype: EmbedderDtype;
  /** Graph file that {@link dtype} selects inside the repository. */
  readonly graphFile: string;
  /** How token states become one vector. */
  readonly pooling: EmbedderPooling;
  /** Whether that vector is scaled to unit length. */
  readonly normalize: boolean;
  /** Prefixes the text carries. Empty strings mean none, which is a fact, not a default. */
  readonly template: EmbedderTemplate;
  /** Exact tokenizer truncation cap the runtime must report. */
  readonly windowTokens: number;
  /** Width of the vector. */
  readonly dimension: number;
  /** Where each value above was read. A value without a source is a value nobody checked. */
  readonly sources: Readonly<Record<string, string>>;
}

const VECTOR_FIELDS = [
  'model',
  'revision',
  'dtype',
  'graphFile',
  'pooling',
  'normalize',
  'template',
  'windowTokens',
  'dimension',
] as const;
const ENTRY_FIELDS = ['id', ...VECTOR_FIELDS, 'sources'] as const;
const DTYPES: readonly EmbedderDtype[] = [
  'fp32',
  'fp16',
  'q8',
  'int8',
  'uint8',
  'q4',
  'q4f16',
  'bnb4',
];
const POOLINGS: readonly EmbedderPooling[] = ['mean', 'cls', 'last_token'];
const GRAPH_BY_DTYPE: Readonly<Record<EmbedderDtype, string>> = {
  fp32: 'onnx/model.onnx',
  fp16: 'onnx/model_fp16.onnx',
  q8: 'onnx/model_quantized.onnx',
  int8: 'onnx/model_int8.onnx',
  uint8: 'onnx/model_uint8.onnx',
  q4: 'onnx/model_q4.onnx',
  q4f16: 'onnx/model_q4f16.onnx',
  bnb4: 'onnx/model_bnb4.onnx',
};

/** Stable identity of every choice that can move or reinterpret a vector. */
export function entryFingerprint(entry: EmbedderEntry): string {
  const vectorShape = {
    // Keep the serialized field name and value stable: incumbent indexes already carry
    // the digest of this exact payload.
    version: EMBEDDER_FINGERPRINT_VERSION,
    model: entry.model,
    revision: entry.revision,
    dtype: entry.dtype,
    graphFile: entry.graphFile,
    pooling: entry.pooling,
    normalize: entry.normalize,
    template: { query: entry.template.query, passage: entry.template.passage },
    windowTokens: entry.windowTokens,
    dimension: entry.dimension,
  };
  return createHash('sha256').update(JSON.stringify(vectorShape)).digest('hex');
}

/** Frozen digest of the exact chain that historically persisted as local:<model>. */
export const LEGACY_INCUMBENT_FINGERPRINT =
  '098eda2e37ba648b3a022a2a87f37f343b46b24812c24a73317b4e709971ee50';

/** Runtime boundary for registry data: incomplete or widened records fail before model I/O. */
export function parseEmbedderEntry(value: unknown): EmbedderEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Embedder entry must be an object.');
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).filter(
    (key) => !(ENTRY_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length)
    throw new Error(`Embedder entry has unknown field(s): ${unknown.join(', ')}.`);
  for (const key of ENTRY_FIELDS)
    if (!(key in row)) throw new Error(`Embedder entry is missing ${key}.`);
  const strings = ['id', 'model', 'revision', 'dtype', 'graphFile', 'pooling'] as const;
  for (const key of strings)
    if (typeof row[key] !== 'string' || !(row[key] as string))
      throw new Error(`Embedder entry ${key} must be a non-empty string.`);
  if (typeof row.normalize !== 'boolean')
    throw new Error('Embedder entry normalize must be boolean.');
  if (!/^[0-9a-f]{40}$/.test(row.revision as string))
    throw new Error('Embedder entry revision must be a pinned 40-character commit SHA.');
  if (!DTYPES.includes(row.dtype as EmbedderDtype))
    throw new Error(`Embedder entry has unsupported dtype ${row.dtype}.`);
  if (!POOLINGS.includes(row.pooling as EmbedderPooling))
    throw new Error(`Embedder entry has unsupported pooling ${row.pooling}.`);
  const expectedGraph = GRAPH_BY_DTYPE[row.dtype as EmbedderDtype];
  if (row.graphFile !== expectedGraph) {
    throw new Error(`Embedder entry graphFile must be ${expectedGraph} for dtype ${row.dtype}.`);
  }
  for (const key of ['windowTokens', 'dimension'] as const) {
    if (!Number.isInteger(row[key]) || (row[key] as number) <= 0)
      throw new Error(`Embedder entry ${key} must be a positive integer.`);
  }
  const template = row.template as Record<string, unknown> | undefined;
  if (
    !template ||
    Object.keys(template).sort().join(',') !== 'passage,query' ||
    typeof template.query !== 'string' ||
    typeof template.passage !== 'string'
  ) {
    throw new Error('Embedder entry template must contain exactly query and passage strings.');
  }
  if (!row.sources || typeof row.sources !== 'object' || Array.isArray(row.sources))
    throw new Error('Embedder entry sources must be an object.');
  for (const field of VECTOR_FIELDS) {
    if (
      typeof (row.sources as Record<string, unknown>)[field] !== 'string' ||
      !(row.sources as Record<string, string>)[field]
    ) {
      throw new Error(`Embedder entry sources must document ${field}.`);
    }
  }
  const frozenTemplate = Object.freeze({
    query: template.query,
    passage: template.passage,
  }) as EmbedderTemplate;
  const frozenSources = Object.freeze({ ...(row.sources as Record<string, string>) });
  return Object.freeze({
    id: row.id,
    model: row.model,
    revision: row.revision,
    dtype: row.dtype,
    graphFile: row.graphFile,
    pooling: row.pooling,
    normalize: row.normalize,
    template: frozenTemplate,
    windowTokens: row.windowTokens,
    dimension: row.dimension,
    sources: frozenSources,
  }) as EmbedderEntry;
}

/** Fields of the record the loader reads today. */
export const APPLIED_FIELDS = VECTOR_FIELDS;

/** Fields the record declares that nothing consumes yet. Kept explicit for the guard test. */
export const DECLARED_ONLY_FIELDS = [] as const;

/** Fields that describe the record rather than the embedder. */
export const ENTRY_METADATA_FIELDS = ['id', 'sources'] as const;

/**
 * The incumbent local embedder: the chain zoteus has run since hybrid search landed.
 *
 * Every value here was read from the model's own published configuration or from the
 * runtime's own defaults, not inferred from a sibling model — pooling especially, which
 * four of six candidates in a recent survey got wrong by assumption, and which degrades
 * retrieval silently when it is wrong, so that it reads as a worse model rather than as a
 * bug.
 */
export const INCUMBENT_LOCAL_ENTRY: EmbedderEntry = parseEmbedderEntry({
  id: 'minilm-l6-v2',
  model: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dtype: 'fp32',
  graphFile: 'onnx/model.onnx',
  pooling: 'mean',
  normalize: true,
  template: { query: '', passage: '' },
  windowTokens: 512,
  dimension: 384,
  sources: {
    model: 'the constructor default this record replaces (LocalEmbeddingProvider)',
    revision:
      'Xenova/all-MiniLM-L6-v2 repository commit characterized on 2026-09-02; pinned so a later ' +
      'change to main cannot silently move vectors under the same entry',
    dtype:
      'DEFAULT_DEVICE_DTYPE in the same package historically selected fp32 under Node; the registry now pins it',
    graphFile: 'DEFAULT_DTYPE_SUFFIX_MAPPING gives fp32 the empty suffix, i.e. onnx/model.onnx',
    pooling:
      '1_Pooling/config.json on sentence-transformers/all-MiniLM-L6-v2 (pooling_mode_mean_tokens ' +
      'true, every other mode false); the Xenova ONNX mirror publishes no pooling config',
    normalize:
      'modules.json on sentence-transformers/all-MiniLM-L6-v2 lists a Normalize module, and the ' +
      'call site passes normalize: true',
    template: 'no prefix on the model card and none at the call site; measured, not assumed',
    windowTokens:
      "tokenizer_config.json model_max_length on Xenova/all-MiniLM-L6-v2. The model card's 256-token " +
      'sentence-transformers training window is descriptive, but the incumbent runtime has always ' +
      'truncated at 512; pinning that effective value preserves its vectors',
    dimension: 'hidden_size in config.json, and the observed width of every vector produced',
  },
});

type Candidate = Pick<
  EmbedderEntry,
  'id' | 'model' | 'revision' | 'pooling' | 'normalize' | 'template' | 'windowTokens' | 'dimension'
>;

const CANDIDATES: readonly Candidate[] = [
  {
    id: 'granite-97m-multilingual-r2',
    model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
    revision: '536a9f241cb3f02a9c5995a1e708c784bd274859',
    pooling: 'cls',
    normalize: true,
    template: { query: '', passage: '' },
    windowTokens: 32768,
    dimension: 384,
  },
  {
    id: 'granite-311m-multilingual-r2',
    model: 'onnx-community/granite-embedding-311m-multilingual-r2-ONNX',
    revision: '8f039f21d4181327268271bea4b11ddcc7eef88d',
    pooling: 'cls',
    normalize: true,
    template: { query: '', passage: '' },
    windowTokens: 32768,
    dimension: 768,
  },
  {
    id: 'arctic-embed-m-v2',
    model: 'Snowflake/snowflake-arctic-embed-m-v2.0',
    revision: '95c2741480856aa9666782eb4afe11959938017f',
    pooling: 'cls',
    normalize: true,
    template: { query: 'query: ', passage: '' },
    windowTokens: 32768,
    dimension: 768,
  },
  {
    id: 'gte-multilingual-base',
    model: 'onnx-community/gte-multilingual-base',
    revision: '2edbf5e672aab465f9ed4c154a8b61791c082c69',
    pooling: 'cls',
    normalize: true,
    template: { query: '', passage: '' },
    windowTokens: 32768,
    dimension: 768,
  },
  {
    id: 'multilingual-e5-small',
    model: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    pooling: 'mean',
    normalize: true,
    template: { query: 'query: ', passage: 'passage: ' },
    windowTokens: 512,
    dimension: 384,
  },
  {
    id: 'multilingual-e5-base',
    model: 'Xenova/multilingual-e5-base',
    revision: '1ec9243030a27d1a115d5c340572074c125b58b2',
    pooling: 'mean',
    normalize: true,
    template: { query: 'query: ', passage: 'passage: ' },
    windowTokens: 512,
    dimension: 768,
  },
];

const MEASURED_DTYPES = ['fp32', 'q8', 'uint8'] as const;
const measuredEntries = CANDIDATES.flatMap((candidate) =>
  MEASURED_DTYPES.map((dtype) =>
    parseEmbedderEntry({
      ...candidate,
      id: `${candidate.id}-${dtype}`,
      dtype,
      graphFile: GRAPH_BY_DTYPE[dtype],
      sources: Object.fromEntries(VECTOR_FIELDS.map((field) => [field,
        field === 'windowTokens'
          ? 'tokenizer_config.json model_max_length in the cached repository revision, verified with Transformers.js 4.2.0'
          : 'bench/models.json and the model repository configuration used by the measured CPU cell',
      ])),
    }),
  ),
).filter((entry) => entry.id !== 'granite-97m-multilingual-r2-q8');

/** Unchanged default plus measured CPU candidates, excluding evidence-rejected cells. */
export const EMBEDDER_ENTRIES: Readonly<Record<string, EmbedderEntry>> = Object.freeze(
  Object.fromEntries([
    [INCUMBENT_LOCAL_ENTRY.id, INCUMBENT_LOCAL_ENTRY],
    ...measuredEntries.map((entry) => [entry.id, entry] as const),
  ]),
);

export class UnknownLocalEmbedderEntryError extends Error {
  constructor(readonly entryId: string) {
    super(
      `Unknown local embedder entry "${entryId}". Choose one of: ${Object.keys(EMBEDDER_ENTRIES).join(', ')}.`,
    );
    this.name = 'UnknownLocalEmbedderEntryError';
  }
}

/** Resolve a user-facing entry id. A raw model repository is intentionally not accepted. */
export function selectEmbedderEntry(id?: string): EmbedderEntry {
  if (!id) return INCUMBENT_LOCAL_ENTRY;
  const entry = EMBEDDER_ENTRIES[id];
  if (!entry) throw new UnknownLocalEmbedderEntryError(id);
  return entry;
}

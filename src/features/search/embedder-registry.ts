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
 * wrote down. Today there is exactly one record: the MiniLM chain zoteus has always used.
 * This file adds no selector and no second entry.
 *
 * WHAT IS AUTHORITATIVE TODAY, AND WHAT IS NOT. {@link APPLIED_FIELDS} lists the fields
 * the loader actually reads; {@link DECLARED_ONLY_FIELDS} lists the fields this record
 * declares but nothing yet consumes. The split is deliberate and it is checked by
 * tests/features/embedder-registry-characterization.test.ts, because a field that is
 * declared and silently unused is worse than a field that is absent: it reads as a
 * guarantee. Making the second list authoritative — and proving each field affects the
 * vectors or the identity as declared — is the next stage of the work, not this one.
 */

/** Shape version of {@link EmbedderEntry}. Bump when a field is added, dropped, or re-meant. */
export const EMBEDDER_REGISTRY_VERSION = 1;

/** Pooling strategies @huggingface/transformers exposes for feature extraction. */
export type EmbedderPooling = 'none' | 'mean' | 'cls' | 'last_token';

/** Numeric type of the ONNX graph that is loaded. */
export type EmbedderDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'q4f16' | 'bnb4';

/** Execution provider the graph runs on. */
export type EmbedderDevice = 'cpu' | 'wasm' | 'webgpu';

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
  /** Execution provider. */
  readonly device: EmbedderDevice;
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
  /** Tokens the model is meant to see. */
  readonly windowTokens: number;
  /** Width of the vector. */
  readonly dimension: number;
  /** Where each value above was read. A value without a source is a value nobody checked. */
  readonly sources: Readonly<Record<string, string>>;
}

/** Fields of the record the loader reads today. */
export const APPLIED_FIELDS = ['model', 'pooling', 'normalize'] as const;

/**
 * Fields the record declares that nothing consumes yet. Each is the value the incumbent
 * chain resolves to on its own, recorded so the next stage can make it authoritative
 * without changing what the vectors are.
 */
export const DECLARED_ONLY_FIELDS = [
  'revision',
  'device',
  'dtype',
  'graphFile',
  'template',
  'windowTokens',
  'dimension',
] as const;

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
export const INCUMBENT_LOCAL_ENTRY: EmbedderEntry = {
  id: 'minilm-l6-v2',
  model: 'Xenova/all-MiniLM-L6-v2',
  revision: 'main',
  device: 'cpu',
  dtype: 'fp32',
  graphFile: 'onnx/model.onnx',
  pooling: 'mean',
  normalize: true,
  template: { query: '', passage: '' },
  windowTokens: 256,
  dimension: 384,
  sources: {
    model: 'the constructor default this record replaces (LocalEmbeddingProvider)',
    revision:
      "not pinned by the caller, so @huggingface/transformers resolves 'main'; that pointed at " +
      '751bff37182d3f1213fa05d7196b954e230abad9 on 2026-09-02',
    device:
      "DEFAULT_DEVICE in @huggingface/transformers 4.2.0 src/utils/devices.js: 'cpu' under Node, " +
      "'wasm' elsewhere",
    dtype:
      'DEFAULT_DEVICE_DTYPE in the same package: fp32 for every device except wasm, which defaults ' +
      'to q8. Nothing pins it today, which is why the value is device-dependent rather than fixed',
    graphFile: 'DEFAULT_DTYPE_SUFFIX_MAPPING gives fp32 the empty suffix, i.e. onnx/model.onnx',
    pooling:
      '1_Pooling/config.json on sentence-transformers/all-MiniLM-L6-v2 (pooling_mode_mean_tokens ' +
      'true, every other mode false); the Xenova ONNX mirror publishes no pooling config',
    normalize:
      'modules.json on sentence-transformers/all-MiniLM-L6-v2 lists a Normalize module, and the ' +
      'call site passes normalize: true',
    template: 'no prefix on the model card and none at the call site; measured, not assumed',
    windowTokens:
      'sentence_bert_config.json max_seq_length on sentence-transformers/all-MiniLM-L6-v2. NOT ' +
      "enforced today: the feature-extraction pipeline truncates at the tokenizer's own " +
      'model_max_length, which tokenizer_config.json sets to 512, so a 660-token passage is cut at ' +
      '512 and not at 256. Deciding which of the two is authoritative moves vectors and therefore ' +
      'belongs to the stage that makes these fields authoritative, not to this one',
    dimension: 'hidden_size in config.json, and the observed width of every vector produced',
  },
};

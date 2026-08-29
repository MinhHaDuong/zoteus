import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ZoteusConfig } from '../../config.js';
import type { Logger } from '../../lib/logger.js';
import { DEFAULT_EMBED_BATCH_SIZE } from './limits.js';

export interface EmbeddingProvider {
  readonly name: string;
  /** Model producing the vectors; part of the index's embedder identity. */
  readonly model?: string;
  /** Weight precision actually in use, when the provider has one; also part of that identity. */
  readonly dtype?: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** npm package that provides the on-device model runtime (optional, not bundled; see below). */
export const TRANSFORMERS_MODULE = '@huggingface/transformers';

/** Per-provider default models. ZOTEUS_EMBEDDING_MODEL overrides whichever one is active. */
export const DEFAULT_API_MODELS: Record<'openai' | 'gemini', string> = {
  openai: 'text-embedding-3-small',
  gemini: 'text-embedding-004',
};

/**
 * Identity of the vectors a provider produces. Two models never share a vector space (nor,
 * usually, a dimension), so an index persists this and refuses to rank its stored vectors
 * against queries embedded by a different one. See SearchIndex.loadFromJSON.
 *
 * Precision belongs in the identity for the same reason the model does, if less obviously:
 * quantising the weights moves the vectors far enough to matter. Measured on
 * Xenova/all-MiniLM-L6-v2, q8 against the fp32 default scores 0.992652 cosine — a real
 * distance, not a rounding artifact, and well outside the band where two spaces can be
 * ranked against each other. An index that mixed them would silently rank q8 rows against
 * fp32 queries with nothing to show for it but slightly worse answers.
 *
 * An unset dtype keeps the identity it has always had, so no existing index is invalidated
 * by this field appearing.
 */
export function embedderIdentity(p: { name: string; model?: string; dtype?: string }): string {
  const base = p.model ? `${p.name}:${p.model}` : p.name;
  return p.dtype ? `${base}@${p.dtype}` : base;
}

/**
 * Pause between embedding batches. 0 (the default) only yields, so a long build stays
 * interruptible and the event loop breathes; a positive value sleeps, which is how a build
 * stays under an API provider's tokens-per-minute limit.
 */
export function batchPause(delayMs = 0): Promise<void> {
  return new Promise((resolve) => {
    if (delayMs > 0) setTimeout(resolve, delayMs);
    else setImmediate(resolve);
  });
}

const DIM = 64;

/** Deterministic, dependency-free embedder. Not semantic — used for tests/plumbing. */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(DIM).fill(0);
      const tokens = t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      for (const tok of tokens) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) h = (h ^ tok.charCodeAt(i)) * 16777619;
        v[Math.abs(h) % DIM] += 1;
      }
      const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / mag);
    });
  }
}

/**
 * Directories to resolve {@link TRANSFORMERS_MODULE} from when ZOTEUS_TRANSFORMERS_PATH is
 * set. Node's own walk-up covers the two common answers (`npm root -g`, or the package
 * directory itself, whose ancestors include that root); the `lib` candidate additionally
 * accepts an npm *prefix* such as `/usr`, where globals live in `/usr/lib/node_modules`.
 */
function overrideRoots(dir: string): string[] {
  return [dir, join(dir, 'lib')];
}

/**
 * Resolve the transformers entry point WITHOUT executing it: a cheap, side-effect-free
 * probe of whether on-device embeddings can actually load. Returns the URL to import, or
 * null when the package is not reachable from this process.
 *
 * This is what makes the degradation reportable *before* a build: a bundled install
 * (.mcpb) resolves only from inside its own folder, which cannot carry the package (its
 * onnxruntime native binaries are ~380 MB across platforms; see docs/semantic-search.md),
 * so status can say so up front instead of silently indexing 0 vectors.
 * ZOTEUS_TRANSFORMERS_PATH is the escape hatch: it points at an install that lives
 * outside the bundle and therefore survives extension updates.
 */
export function resolveTransformers(transformersPath?: string): string | null {
  const dir = transformersPath?.trim();
  if (dir) {
    for (const root of overrideRoots(dir)) {
      try {
        // A non-existent package.json is fine: createRequire only needs a base path to
        // start the node_modules walk-up from.
        const req = createRequire(pathToFileURL(join(root, 'package.json')));
        return pathToFileURL(req.resolve(TRANSFORMERS_MODULE)).href;
      } catch {
        // Try the next reading of the configured path.
      }
    }
    return null;
  }
  try {
    return import.meta.resolve(TRANSFORMERS_MODULE);
  } catch {
    return null;
  }
}

/**
 * Actionable, install-channel-aware explanation for "local embeddings requested but
 * unavailable". Desktop bundles get different advice from npm installs because there is
 * no `npm i` step to have skipped: the package has to live outside the bundle.
 */
export function missingTransformersHint(config?: Pick<ZoteusConfig, 'dist'>): string {
  const bundled = config?.dist === 'mcpb' || config?.dist === 'dxt';
  // The FIRST sentence is the short cause that ends up in the one-line embedder label
  // (see shortCause in index-manager); everything after it is the remedy. Keep it short.
  const cause = `${TRANSFORMERS_MODULE} is not installed.`;
  const fallbacks =
    `Otherwise set ZOTEUS_EMBEDDINGS=openai or gemini to embed through an API instead (your ` +
    `library text leaves the machine), or ZOTEUS_EMBEDDINGS=off to accept keyword-only search.`;
  if (bundled) {
    return (
      `${cause} Semantic ranking is off; keyword (BM25) search still works. Desktop-extension ` +
      `bundles cannot ship it: it pulls in onnxruntime's native binaries (~380 MB across platforms). ` +
      `To get on-device vectors, install it outside the bundle (\`npm i -g ${TRANSFORMERS_MODULE}\`) ` +
      `and set the extension's "Local embeddings path" (ZOTEUS_TRANSFORMERS_PATH) to the directory ` +
      `\`npm root -g\` prints; that survives extension updates. ${fallbacks}`
    );
  }
  return (
    `${cause} Semantic ranking is off; keyword (BM25) search still works. Install it with ` +
    `\`npm i ${TRANSFORMERS_MODULE}\`, or point ZOTEUS_TRANSFORMERS_PATH at a directory that ` +
    `already has it. ${fallbacks}`
  );
}

/** Local on-device embeddings via @huggingface/transformers (optional, lazy). */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  /** Texts handed to the transformers pipeline in a single call. */
  static readonly BATCH_SIZE = DEFAULT_EMBED_BATCH_SIZE;
  private extractor: any;
  constructor(
    readonly model = 'Xenova/all-MiniLM-L6-v2',
    /** Injectable extractor factory (tests); defaults to the transformers.js pipeline. */
    private readonly loadExtractor?: () => Promise<any>,
    private readonly opts: {
      transformersPath?: string;
      dist?: string;
      /** Where downloaded model weights live (see modelCacheDir); unset keeps the package's default. */
      modelCacheDir?: string;
      /** Texts per pipeline call (defaults to BATCH_SIZE). */
      batchSize?: number;
      /** Pause between batches in ms (see batchPause). */
      batchDelayMs?: number;
      /** Weight precision passed to the pipeline; unset keeps the runtime's default. */
      dtype?: string;
    } = {},
  ) {}

  /**
   * The precision these vectors are produced at. Constant for the provider's life, which
   * is load-bearing rather than incidental.
   *
   * This value feeds the embedder identity, and the index stamps that identity BEFORE the
   * first embed call — `SearchIndexBase.build` sets `vectorEmbedderId` while the records
   * are still unembedded, and the incremental path does the same. A provider that quietly
   * downgraded its precision on a failed load would therefore stamp one identity and then
   * produce vectors of another, leaving the index labelled with a precision it does not
   * hold. Nothing downstream could catch that: quantisation does not change the vector
   * width, so the dimension check on the query path sees nothing wrong, and the identity
   * string is the only defence there is. A precision that will not load is an error, never
   * a silent substitution.
   */
  get dtype(): string | undefined {
    return this.opts.dtype;
  }

  private async ensure(): Promise<any> {
    if (this.extractor) return this.extractor;
    if (this.loadExtractor) {
      this.extractor = await this.loadExtractor();
      return this.extractor;
    }
    const specifier = resolveTransformers(this.opts.transformersPath);
    if (!specifier) throw new Error(missingTransformersHint({ dist: this.opts.dist }));
    let transformers: any;
    try {
      transformers = await import(specifier);
    } catch (e) {
      // Resolved but unloadable: almost always a native onnxruntime binary that does not
      // match this platform/Node ABI. Say that, rather than "not installed".
      throw new Error(
        `${TRANSFORMERS_MODULE} resolved but failed to load (${e instanceof Error ? e.message : String(e)}). ` +
          'Reinstall it for this platform and Node version, or set ZOTEUS_EMBEDDINGS=off for keyword-only search.',
      );
    }
    // The package ships both an ESM and a CJS build; a resolved CJS entry arrives under `default`.
    const pipeline = transformers.pipeline ?? transformers.default?.pipeline;
    if (typeof pipeline !== 'function') {
      throw new Error(`${TRANSFORMERS_MODULE} loaded but exposes no pipeline(). Is the install complete?`);
    }
    // Pin the model cache before the pipeline downloads anything. The package's default
    // caches weights inside its own install directory, which outlives the data directory —
    // and for a bundled desktop install pointed at a global module via
    // ZOTEUS_TRANSFORMERS_PATH, outlives the extension too. Deleting the data directory
    // is supposed to be the whole uninstall, and the weights are its largest artifact.
    const env = transformers.env ?? transformers.default?.env;
    if (env && this.opts.modelCacheDir) env.cacheDir = this.opts.modelCacheDir;
    this.extractor = await this.construct(pipeline);
    return this.extractor;
  }

  /**
   * Build the pipeline at the configured precision.
   *
   * The options object is built rather than spelled out so an unset dtype leaves the key
   * ABSENT. `{dtype: undefined}` is a third call shape, distinct from both this one and
   * from the bare call that shipped before, and passing it would make the default path
   * depend on how the runtime happens to treat an explicit undefined.
   *
   * A precision that will not load is reported, not worked around. Measured on
   * @huggingface/transformers 4.2.0, linux-x64: `fp16` throws at session init on the CPU
   * provider — a graph-fusion failure, not a missing kernel. Retrying at the default
   * precision would keep semantic search alive, and was the first thing tried here; it is
   * wrong because of what the precision is wired into. See the `dtype` getter: the index
   * stamps the embedder identity before the first embed, so a provider that changed
   * precision mid-flight would leave the stored vectors labelled with a precision they do
   * not have, which is the one failure the identity exists to prevent and the one nothing
   * downstream can detect.
   *
   * Failing here is not "taking the server down". It reaches `noteEmbedFailure` like any
   * other embedder failure, so the index falls back to keyword-only, reports the reason
   * through `embedderReason`, and repeats it in every search summary — the same path a
   * missing @huggingface/transformers already takes. The message names the value and the
   * model, because the remedy is to change or unset one environment variable.
   *
   * Note what this does NOT cover. An unrecognised value such as `q7` never throws: the
   * runtime ignores it and serves the default precision, bit-identical. No catch can see
   * that, so nothing here pretends to guard against a mistyped dtype.
   */
  private async construct(pipeline: (...args: any[]) => Promise<any>): Promise<any> {
    const pipelineOpts: { dtype?: string } = {};
    if (this.opts.dtype) pipelineOpts.dtype = this.opts.dtype;
    try {
      return await pipeline('feature-extraction', this.model, pipelineOpts);
    } catch (e) {
      if (!this.opts.dtype) throw e;
      throw new Error(
        `ZOTEUS_EMBEDDING_DTYPE=${this.opts.dtype} could not be loaded for ${this.model} ` +
          `(${e instanceof Error ? e.message : String(e)}). Semantic ranking is off; keyword (BM25) ` +
          'search still works. Unset the variable to use the runtime default precision, or pick a ' +
          'value this model publishes and that loads on this machine.',
      );
    }
  }

  /**
   * Embed texts in batches through the pipeline (one call per batch instead of one
   * per text), yielding to the event loop between batches so long builds stay
   * responsive and interruptible. Returns exactly one vector per input text.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.ensure();
    const size = Math.max(1, this.opts.batchSize ?? LocalEmbeddingProvider.BATCH_SIZE);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
      const data = tensor.data as Float32Array;
      const dims: number[] | undefined = tensor.dims;
      const dim = dims && dims.length > 1 ? dims[dims.length - 1]! : data.length / batch.length;
      for (let b = 0; b < batch.length; b++) {
        out.push(Array.from(data.slice(b * dim, (b + 1) * dim)));
      }
      if (i + size < texts.length) await batchPause(this.opts.batchDelayMs);
    }
    return out;
  }
}

export interface ApiEmbeddingOptions {
  /** Model to embed with; defaults to the provider's own (see DEFAULT_API_MODELS). */
  model?: string;
  /** Max texts per request. Unset sends them all in one request, as before. */
  batchSize?: number;
  /** Pause between requests in ms (see batchPause). */
  batchDelayMs?: number;
}

/** OpenAI/Gemini embeddings (opt-in; data leaves the machine). */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  /** Bare model name: the `models/` prefix is Gemini wire format, not part of the identity. */
  readonly model: string;
  constructor(
    private readonly kind: 'openai' | 'gemini',
    private readonly apiKey: string,
    private readonly opts: ApiEmbeddingOptions = {},
  ) {
    this.name = kind;
    this.model = (opts.model?.trim() || DEFAULT_API_MODELS[kind]).replace(/^models\//, '');
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const size = Math.max(1, this.opts.batchSize ?? texts.length);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      out.push(...(await this.embedBatch(texts.slice(i, i + size))));
      if (i + size < texts.length) await batchPause(this.opts.batchDelayMs);
    }
    return out;
  }

  /** One request. Providers reject an oversized batch whole, hence the caller's batching. */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.kind === 'openai') {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!res.ok) throw new Error(`OpenAI embeddings failed (${res.status}).`);
      const json = (await res.json()) as any;
      return json.data.map((d: any) => d.embedding);
    }
    // The key travels in a header, like the OpenAI one above, never in the URL: URLs are
    // the part of a request that gets logged — by proxies, by error causes, by anything
    // that prints which endpoint failed — and Google accepts x-goog-api-key everywhere
    // ?key= works.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          requests: texts.map((t) => ({ model: `models/${this.model}`, content: { parts: [{ text: t }] } })),
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini embeddings failed (${res.status}).`);
    const json = (await res.json()) as any;
    return json.embeddings.map((e: any) => e.values);
  }
}

/**
 * What ZOTEUS_EMBEDDINGS asked for, and whether it can actually be honoured. Keeping the
 * two apart is the point: reporting the *configured* provider as if it were active is what
 * turned a missing optional dependency into an invisible "0 vectors" failure (#7).
 */
export interface EmbedderSelection {
  /** Provider that will produce vectors, or null for keyword-only search. */
  provider: EmbeddingProvider | null;
  /** The requested ZOTEUS_EMBEDDINGS value. */
  configured: ZoteusConfig['embeddings'];
  /** Why no provider, when `configured` asked for one. Absent when nothing is wrong. */
  unavailable?: string;
}

/**
 * Build the configured provider. Preflights the local runtime so an install that cannot
 * embed is known at startup, before a build silently produces an index with 0 vectors.
 */
export function createEmbeddingProvider(config: ZoteusConfig, logger?: Logger): EmbedderSelection {
  // ZOTEUS_EMBEDDING_MODEL names the model of whichever API provider is active; the batch
  // and delay dials apply to every provider that batches.
  const api: ApiEmbeddingOptions = {
    model: config.embeddingModel,
    batchSize: config.embedBatchSize,
    batchDelayMs: config.embedBatchDelayMs,
  };
  switch (config.embeddings) {
    case 'off':
      return { provider: null, configured: 'off' };
    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        const unavailable =
          'OPENAI_API_KEY is unset. No vectors are produced; keyword (BM25) search still works. ' +
          'Set the key, or pick another ZOTEUS_EMBEDDINGS provider.';
        logger?.warn(`ZOTEUS_EMBEDDINGS=openai but OPENAI_API_KEY is unset; using keyword-only search.`);
        return { provider: null, configured: 'openai', unavailable };
      }
      return { provider: new ApiEmbeddingProvider('openai', process.env.OPENAI_API_KEY, api), configured: 'openai' };
    case 'gemini':
      if (!process.env.GEMINI_API_KEY) {
        const unavailable =
          'GEMINI_API_KEY is unset. No vectors are produced; keyword (BM25) search still works. ' +
          'Set the key, or pick another ZOTEUS_EMBEDDINGS provider.';
        logger?.warn(`ZOTEUS_EMBEDDINGS=gemini but GEMINI_API_KEY is unset; using keyword-only search.`);
        return { provider: null, configured: 'gemini', unavailable };
      }
      return { provider: new ApiEmbeddingProvider('gemini', process.env.GEMINI_API_KEY, api), configured: 'gemini' };
    case 'local':
    default:
      if (!resolveTransformers(config.transformersPath)) {
        logger?.warn(`ZOTEUS_EMBEDDINGS=local but ${TRANSFORMERS_MODULE} is not installed; using keyword-only search.`);
        return { provider: null, configured: 'local', unavailable: missingTransformersHint(config) };
      }
      // No `device` is passed, deliberately. The runtime's Node default is already
      // ['cpu']; `device: 'auto'` hands ONNX Runtime the whole per-platform provider list
      // instead, and on linux-x64 that list always begins with CUDA — gated on
      // platform/arch alone, never on whether CUDA is usable. There is no fallback loop to
      // catch it: createInferenceSession passes the list straight to the binding. Measured
      // on a clean install of @huggingface/transformers 4.2.0 with no NVIDIA runtime
      // present, `device: 'auto'` fails the session outright with
      // "OrtSessionOptionsAppendExecutionProvider_Cuda: Failed to load shared library
      // ... libcublasLt.so.12", where the same call with no device option loads and serves.
      // That is the shipped default path for most Linux users, so it stays untouched.
      return {
        provider: new LocalEmbeddingProvider(undefined, undefined, {
          transformersPath: config.transformersPath,
          dist: config.dist,
          modelCacheDir: join(config.dataDir, 'models'),
          batchSize: config.embedBatchSize,
          batchDelayMs: config.embedBatchDelayMs,
          dtype: config.embeddingDtype,
        }),
        configured: 'local',
      };
  }
}

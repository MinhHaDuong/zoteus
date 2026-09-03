import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ZoteusConfig } from '../../config.js';
import type { Logger } from '../../lib/logger.js';
import {
  INCUMBENT_LOCAL_ENTRY,
  LEGACY_INCUMBENT_FINGERPRINT,
  entryFingerprint,
  parseEmbedderEntry,
  selectEmbedderEntry,
  type EmbedderEntry,
} from './embedder-registry.js';
import { DEFAULT_EMBED_BATCH_SIZE } from './limits.js';
import type { EmbedderRuntimeShape } from './embedder-validation.js';

export interface EmbeddingProvider {
  readonly name: string;
  /** Model producing the vectors; part of the index's embedder identity. */
  readonly model?: string;
  /** Curated configuration id, when the provider is registry-backed. */
  readonly entryId?: string;
  embed(texts: string[], role?: 'query' | 'passage'): Promise<number[][]>;
}

/** npm package that provides the on-device model runtime (optional, not bundled; see below). */
export const TRANSFORMERS_MODULE = '@huggingface/transformers';

/** The concrete device supplied to the loader; validation records its CPU provider. */
export const LOCAL_EXECUTION_DEVICE = 'cpu' as const;

/** API-provider defaults. On the local path ZOTEUS_EMBEDDING_MODEL selects a registry entry. */
export const DEFAULT_API_MODELS: Record<'openai' | 'gemini', string> = {
  openai: 'text-embedding-3-small',
  gemini: 'text-embedding-004',
};

const GRAPH_SUFFIX_BY_DTYPE: Readonly<Record<EmbedderEntry['dtype'], string>> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  q4f16: '_q4f16',
  bnb4: '_bnb4',
};

/**
 * Identity of the vectors a provider produces. Two models never share a vector space (nor,
 * usually, a dimension), so an index persists this and refuses to rank its stored vectors
 * against queries embedded by a different one. See SearchIndex.loadFromJSON.
 */
export function embedderIdentity(p: {
  name: string;
  model?: string;
  vectorFingerprint?: string;
  legacyIdentity?: boolean;
}): string {
  if (p.vectorFingerprint && !p.legacyIdentity) return `${p.name}:registry-v${p.vectorFingerprint}`;
  return p.model ? `${p.name}:${p.model}` : p.name;
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
 * set. Node's own walk-up covers the two common answers (a `node_modules` directory, or the
 * package directory itself, whose ancestors include one); the `lib` candidate additionally
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
 * (.mcpb) resolves only from inside its own folder, which cannot carry the package (the
 * resolved tree is roughly 700 MB, onnxruntime's native binaries included; see
 * docs/semantic-search.md), so status can say so up front instead of silently indexing 0
 * vectors. ZOTEUS_TRANSFORMERS_PATH is the escape hatch: it points at an install that
 * lives outside the bundle and therefore survives extension updates.
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
 * Where the resolver was told to look, in the words of the setting that sent it there.
 *
 * A wrong ZOTEUS_TRANSFORMERS_PATH is the commonest way local embeddings fail on a desktop
 * install (#38), and until now the path appeared in nothing the user could read: it lives
 * in a settings pane, its only other copy is in an environment nobody can print, and every
 * message said "not installed" whether the package was absent or merely somewhere else.
 * Naming the directory turns an unfalsifiable claim into one `ls` away from an answer.
 */
function searchedHint(transformersPath?: string): string {
  const dir = transformersPath?.trim();
  if (!dir) return '';
  return (
    ` ZOTEUS_TRANSFORMERS_PATH is set to "${dir}", and ${TRANSFORMERS_MODULE} resolves from ` +
    `neither it nor "${join(dir, 'lib')}".`
  );
}

/** The same fact as {@link searchedHint}, in the middle of a sentence rather than after one. */
function searchedFrom(transformersPath?: string): string {
  const dir = transformersPath?.trim();
  return dir ? ` (ZOTEUS_TRANSFORMERS_PATH=${dir})` : '';
}

/** A resolved specifier as a path someone can paste into `ls`, not as a file:// URL. */
function modulePath(specifier: string): string {
  try {
    return specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;
  } catch {
    return specifier;
  }
}

/**
 * Actionable, install-channel-aware explanation for "local embeddings requested but
 * unavailable". Desktop bundles get different advice from npm installs because there is
 * no `npm i` step to have skipped: the package has to live outside the bundle.
 */
export function missingTransformersHint(
  config?: Pick<ZoteusConfig, 'dist' | 'transformersPath'>,
): string {
  const bundled = config?.dist === 'mcpb' || config?.dist === 'dxt';
  // The FIRST sentence is the short cause that ends up in the one-line embedder label
  // (see shortCause in index-manager); everything after it is the remedy. Keep it short.
  const cause = `${TRANSFORMERS_MODULE} is not installed.`;
  const searched = searchedHint(config?.transformersPath);
  const fallbacks =
    `Otherwise set ZOTEUS_EMBEDDINGS=openai or gemini to embed through an API instead (your ` +
    `library text leaves the machine), or ZOTEUS_EMBEDDINGS=off to accept keyword-only search.`;
  if (bundled) {
    // Deliberately NOT `npm i -g`. Claude Desktop runs the server with its own built-in
    // Node, not the one on the user's PATH, so a global root under a version manager holds
    // onnxruntime binaries built for a Node this process never executes, and an nvm switch
    // later moves the directory out from under the setting (#38). A directory of its own,
    // owned by nobody's version manager, is the install that keeps working.
    return (
      `${cause} Semantic ranking is off; keyword (BM25) search still works.${searched} Desktop-extension ` +
      `bundles cannot ship it: the resolved dependency tree, onnxruntime's native binaries included, is ` +
      `about 700 MB. Install it into a directory of its own, outside any Node version manager (the ` +
      `desktop app runs this server with its own built-in Node, not the one on your PATH): ` +
      `\`mkdir -p ~/.zoteus-deps && cd ~/.zoteus-deps && npm init -y && npm i ${TRANSFORMERS_MODULE}\`, ` +
      `then set the extension's "Local embeddings path" (ZOTEUS_TRANSFORMERS_PATH) to that folder's ` +
      `node_modules. It survives extension updates and Node version switches alike. ${fallbacks}`
    );
  }
  return (
    `${cause} Semantic ranking is off; keyword (BM25) search still works.${searched} Install it with ` +
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
  private transformers: any;
  readonly entry: EmbedderEntry;
  readonly model: string;
  readonly entryId: string;
  readonly vectorFingerprint: string;
  readonly legacyIdentity: boolean;
  constructor(
    /** Defaults to the registry's incumbent entry. Raw model names are never accepted. */
    entry: EmbedderEntry = INCUMBENT_LOCAL_ENTRY,
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
      /** Explicit environment for an injected extractor (tests and transport adapters). */
      validationRuntime?: EmbedderRuntimeShape;
    } = {},
  ) {
    if (typeof entry === 'string') {
      throw new Error('LocalEmbeddingProvider requires a complete registry entry, not a raw model name.');
    }
    this.entry = parseEmbedderEntry(entry);
    this.model = this.entry.model;
    this.entryId = this.entry.id;
    this.vectorFingerprint = entryFingerprint(this.entry);
    this.legacyIdentity = this.vectorFingerprint === LEGACY_INCUMBENT_FINGERPRINT;
  }

  /** Import the exact runtime module once, without loading model weights. */
  private async ensureTransformers(): Promise<any> {
    if (this.transformers) return this.transformers;
    const specifier = resolveTransformers(this.opts.transformersPath);
    if (!specifier)
      throw new Error(
        missingTransformersHint({
          dist: this.opts.dist,
          transformersPath: this.opts.transformersPath,
        }),
      );
    try {
      this.transformers = await import(specifier);
    } catch (e) {
      // Resolved but unloadable: almost always a native onnxruntime binary that does not
      // match this platform/Node ABI. Say that, rather than "not installed", and say
      // WHICH file was loaded, under which Node.
      throw new Error(
        `${TRANSFORMERS_MODULE} resolved but failed to load (${e instanceof Error ? e.message : String(e)}). ` +
          `Loaded from ${modulePath(specifier)}${searchedFrom(this.opts.transformersPath)}, running Node ` +
          `${process.version} on ${process.platform}-${process.arch}. ` +
          'Reinstall it for this platform and Node version, or set ZOTEUS_EMBEDDINGS=off for keyword-only search.',
      );
    }
    const env = this.transformers.env ?? this.transformers.default?.env;
    if (env && this.opts.modelCacheDir) env.cacheDir = this.opts.modelCacheDir;
    return this.transformers;
  }

  /** Exact environment tuple that owns a cached compatibility PASS. */
  async validationRuntimeShape(): Promise<EmbedderRuntimeShape> {
    if (this.loadExtractor) {
      if (!this.opts.validationRuntime) {
        throw new Error('An injected local extractor must declare its validation runtime.');
      }
      return this.opts.validationRuntime;
    }
    const transformers = await this.ensureTransformers();
    const env = transformers.env ?? transformers.default?.env;
    const backendVersions = Object.fromEntries(
      Object.entries(env?.backends?.onnx?.versions ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
      ),
    );
    return {
      engineVersion: typeof env?.version === 'string' ? env.version : '',
      backendVersions,
      runtime: process.versions.electron ? 'electron' : 'node',
      nodeVersion: process.versions.node,
      ...(process.versions.electron ? { electronVersion: process.versions.electron } : {}),
      operatingSystem: process.platform,
      architecture: process.arch,
      // The loader below receives this same concrete value. A future positive device
      // probe must change both together and record its result rather than "auto".
      executionProvider: LOCAL_EXECUTION_DEVICE,
    };
  }

  /** Options that select the actual graph/runtime chain. Exposed for characterization tests. */
  get loaderOptions(): {
    revision: string;
    dtype: EmbedderEntry['dtype'];
    subfolder: string;
    model_file_name: string;
    device: typeof LOCAL_EXECUTION_DEVICE;
  } {
    const [subfolder, filename] = this.entry.graphFile.split('/');
    const suffix = GRAPH_SUFFIX_BY_DTYPE[this.entry.dtype];
    return {
      revision: this.entry.revision,
      dtype: this.entry.dtype,
      subfolder: subfolder!,
      model_file_name: filename!.slice(0, -suffix.length - '.onnx'.length),
      device: LOCAL_EXECUTION_DEVICE,
    };
  }

  private async ensure(): Promise<any> {
    if (this.extractor) return this.extractor;
    if (this.loadExtractor) {
      this.extractor = await this.loadExtractor();
      this.configureTokenizerWindow(this.extractor);
      return this.extractor;
    }
    const transformers = await this.ensureTransformers();
    // The package ships both an ESM and a CJS build; a resolved CJS entry arrives under `default`.
    const pipeline = transformers.pipeline ?? transformers.default?.pipeline;
    if (typeof pipeline !== 'function') {
      throw new Error(
        `${TRANSFORMERS_MODULE} loaded but exposes no pipeline(). Is the install complete?`,
      );
    }
    // Pin the model cache before the pipeline downloads anything. The package's default
    // caches weights inside its own install directory, which outlives the data directory —
    // and for a bundled desktop install pointed at a global module via
    // ZOTEUS_TRANSFORMERS_PATH, outlives the extension too. Deleting the data directory
    // is supposed to be the whole uninstall, and the weights are its largest artifact.
    this.extractor = await pipeline('feature-extraction', this.model, this.loaderOptions);
    if (!this.extractor.tokenizer) {
      throw new Error(`Local embedder ${this.entry.id} loaded without an addressable tokenizer.`);
    }
    this.configureTokenizerWindow(this.extractor);
    return this.extractor;
  }

  private configureTokenizerWindow(extractor: any): void {
    const tokenizer = extractor.tokenizer;
    const available = tokenizer?.model_max_length;
    if (typeof available !== 'number' || available < this.entry.windowTokens) {
      throw new Error(
        `Local embedder ${this.entry.id} tokenizer window is ${String(available)}; ` +
          `the registry entry requires capacity for ${this.entry.windowTokens}.`,
      );
    }
    if (typeof tokenizer !== 'function') {
      if (available !== this.entry.windowTokens) {
        throw new Error(`Local embedder ${this.entry.id} cannot apply the registry tokenizer window.`);
      }
      return;
    }
    const cap = this.entry.windowTokens;
    extractor.tokenizer = new Proxy(tokenizer, {
      apply(target, thisArg, args: [unknown, Record<string, unknown>?]) {
        const [texts, options = {}] = args;
        return Reflect.apply(target, thisArg, [texts, { ...options, max_length: cap }]);
      },
      get(target, property, receiver) {
        if (property === 'model_max_length') return cap;
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /**
   * Embed texts in batches through the pipeline (one call per batch instead of one
   * per text), yielding to the event loop between batches so long builds stay
   * responsive and interruptible. Returns exactly one vector per input text.
   */
  private async embedPrepared(texts: string[], normalize: boolean): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.ensure();
    const size = Math.max(1, this.opts.batchSize ?? LocalEmbeddingProvider.BATCH_SIZE);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      // Pooling and normalization are not call-site taste: they are properties of the
      // model, published in its own configuration, and a wrong pooling mode produces
      // vectors that load and rank and are quietly worse. They come from the entry.
      const tensor = await extractor(batch, {
        pooling: this.entry.pooling,
        normalize,
      });
      const data = tensor.data as Float32Array;
      const dims: number[] | undefined = tensor.dims;
      const shapeIsExact =
        dims?.length === 2 &&
        dims[0] === batch.length &&
        dims[1] === this.entry.dimension &&
        data.length === batch.length * this.entry.dimension;
      if (!shapeIsExact) {
        throw new Error(
          `Local embedder ${this.entry.id} produced tensor shape ${JSON.stringify(dims)} with ${data.length} values; ` +
            `expected ${this.entry.dimension} dimensions in shape [${batch.length},${this.entry.dimension}].`,
        );
      }
      const dim = this.entry.dimension;
      for (let b = 0; b < batch.length; b++) {
        out.push(Array.from(data.slice(b * dim, (b + 1) * dim)));
      }
      if (i + size < texts.length) await batchPause(this.opts.batchDelayMs);
    }
    return out;
  }

  /** Validation-only bypass: callers supply the complete, already-templated strings. */
  async embedPreparedForValidation(texts: string[], normalize: boolean): Promise<number[][]> {
    return this.embedPrepared(texts, normalize);
  }

  async embed(texts: string[], role: 'query' | 'passage' = 'passage'): Promise<number[][]> {
    const prefix = this.entry.template[role];
    return this.embedPrepared(
      texts.map((text) => `${prefix}${text}`),
      this.entry.normalize,
    );
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
  private requestMade = false;
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
      if (this.requestMade) await batchPause(this.opts.batchDelayMs);
      out.push(...(await this.embedBatch(texts.slice(i, i + size))));
      this.requestMade = true;
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
          requests: texts.map((t) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text: t }] },
          })),
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
  // On API paths ZOTEUS_EMBEDDING_MODEL is a provider model name. The local path resolves
  // it separately as a curated registry id. Batch and delay apply to every provider.
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
        logger?.warn(
          `ZOTEUS_EMBEDDINGS=openai but OPENAI_API_KEY is unset; using keyword-only search.`,
        );
        return { provider: null, configured: 'openai', unavailable };
      }
      return {
        provider: new ApiEmbeddingProvider('openai', process.env.OPENAI_API_KEY, api),
        configured: 'openai',
      };
    case 'gemini':
      if (!process.env.GEMINI_API_KEY) {
        const unavailable =
          'GEMINI_API_KEY is unset. No vectors are produced; keyword (BM25) search still works. ' +
          'Set the key, or pick another ZOTEUS_EMBEDDINGS provider.';
        logger?.warn(
          `ZOTEUS_EMBEDDINGS=gemini but GEMINI_API_KEY is unset; using keyword-only search.`,
        );
        return { provider: null, configured: 'gemini', unavailable };
      }
      return {
        provider: new ApiEmbeddingProvider('gemini', process.env.GEMINI_API_KEY, api),
        configured: 'gemini',
      };
    case 'local':
    default: {
      // On the local path this setting names a complete curated entry, never a raw HF repo.
      // Resolve it before probing or touching the index so a typo cannot degrade silently.
      const entry = selectEmbedderEntry(config.embeddingModel);
      if (!resolveTransformers(config.transformersPath)) {
        logger?.warn(
          `ZOTEUS_EMBEDDINGS=local but ${TRANSFORMERS_MODULE} is not installed` +
            `${searchedFrom(config.transformersPath)}; using keyword-only search.`,
        );
        return {
          provider: null,
          configured: 'local',
          unavailable: missingTransformersHint(config),
        };
      }
      return {
        provider: new LocalEmbeddingProvider(entry, undefined, {
          transformersPath: config.transformersPath,
          dist: config.dist,
          modelCacheDir: join(config.dataDir, 'models'),
          batchSize: config.embedBatchSize,
          batchDelayMs: config.embedBatchDelayMs,
        }),
        configured: 'local',
      };
    }
  }
}

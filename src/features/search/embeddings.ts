import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ZoteusConfig } from '../../config.js';
import type { Logger } from '../../lib/logger.js';
import { DEFAULT_EMBED_BATCH_SIZE } from './limits.js';

/**
 * Which side of a search a text belongs to. Symmetric models ignore it; the E5 family does
 * not (see {@link inputPrefixes}), and a provider that needs the distinction cannot recover
 * it from the text itself. `passage` is the default because indexing is what every existing
 * caller does.
 */
export type EmbedKind = 'query' | 'passage';

export interface EmbeddingProvider {
  readonly name: string;
  /** Model producing the vectors; part of the index's embedder identity. */
  readonly model?: string;
  embed(texts: string[], kind?: EmbedKind): Promise<number[][]>;
}

/** npm package that provides the on-device model runtime (optional, not bundled; see below). */
export const TRANSFORMERS_MODULE = '@huggingface/transformers';

/** Per-provider default models. ZOTEUS_EMBEDDING_MODEL overrides whichever one is active. */
export const DEFAULT_API_MODELS: Record<'openai' | 'gemini', string> = {
  openai: 'text-embedding-3-small',
  gemini: 'text-embedding-004',
};

/**
 * The on-device default: small, fast, and English-centric. ZOTEUS_EMBEDDING_MODEL names any
 * other transformers.js feature-extraction model instead (#43), which is how a German or
 * otherwise multilingual library gets an embedder trained for it, e.g.
 * `Xenova/multilingual-e5-small`. It stays the default because changing it under an existing
 * index would silently invalidate everyone's vectors.
 */
export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * The E5 family (and the instruct models built on it) is trained with these markers on its
 * inputs, and asymmetrically: a question is a `query: `, a document is a `passage: `.
 * Dropping them does not fail, it just retrieves worse, which is the kind of loss nobody
 * ever attributes to a missing string.
 */
export const E5_PREFIXES: Readonly<Record<EmbedKind, string>> = { query: 'query: ', passage: 'passage: ' };

/** How input prefixes are chosen: from the model id, never, or E5's regardless of the id. */
export type PrefixMode = 'auto' | 'off' | 'e5';

/**
 * `e5` as a segment of the model id, not as two letters inside a word: `Xenova/multilingual-e5-small`
 * and `intfloat/e5-base-v2` are E5 models, `sentence-t5-base` is not.
 */
const E5_MODEL = /(?:^|[/\-_.])e5(?:[/\-_.]|$)/i;

/**
 * The prefixes to put in front of each side's texts, or null for a model that wants none.
 * Auto-detection is the deliverable; `mode` is the escape hatch for a mirrored or renamed
 * checkpoint the id cannot speak for.
 */
export function inputPrefixes(model: string, mode: PrefixMode = 'auto'): Readonly<Record<EmbedKind, string>> | null {
  if (mode === 'off') return null;
  if (mode === 'e5') return E5_PREFIXES;
  return E5_MODEL.test(model) ? E5_PREFIXES : null;
}

/**
 * Identity of the vectors a provider produces. Two models never share a vector space (nor,
 * usually, a dimension), so an index persists this and refuses to rank its stored vectors
 * against queries embedded by a different one. See SearchIndex.loadFromJSON.
 */
export function embedderIdentity(p: { name: string; model?: string }): string {
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
export function missingTransformersHint(config?: Pick<ZoteusConfig, 'dist' | 'transformersPath'>): string {
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
  constructor(
    readonly model: string = DEFAULT_LOCAL_MODEL,
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
      /** Input-prefix policy for this model (see inputPrefixes); unset means auto. */
      prefixes?: PrefixMode;
    } = {},
  ) {}

  /**
   * What this model wants in front of a query and in front of a passage, or null. Computed
   * from the model id, so it never reaches the embedder identity or the stored text: the
   * prefix is an argument to the model, not a property of the vectors it returns.
   */
  get prefixes(): Readonly<Record<EmbedKind, string>> | null {
    return inputPrefixes(this.model, this.opts.prefixes ?? 'auto');
  }

  private async ensure(): Promise<any> {
    if (this.extractor) return this.extractor;
    if (this.loadExtractor) {
      this.extractor = await this.loadExtractor();
      return this.extractor;
    }
    const specifier = resolveTransformers(this.opts.transformersPath);
    if (!specifier)
      throw new Error(
        missingTransformersHint({ dist: this.opts.dist, transformersPath: this.opts.transformersPath }),
      );
    let transformers: any;
    try {
      transformers = await import(specifier);
    } catch (e) {
      // Resolved but unloadable: almost always a native onnxruntime binary that does not
      // match this platform/Node ABI. Say that, rather than "not installed", and say
      // WHICH file was loaded, under which Node. That is the whole diagnosis for the
      // desktop failure in #38: the extension runs its own built-in Node, so a package
      // installed under a version manager (or left behind by an nvm switch) resolves
      // perfectly and then fails on a binary compiled for a different runtime. Without
      // the path and the version, the two halves of that sentence are invisible.
      throw new Error(
        `${TRANSFORMERS_MODULE} resolved but failed to load (${e instanceof Error ? e.message : String(e)}). ` +
          `Loaded from ${modulePath(specifier)}${searchedFrom(this.opts.transformersPath)}, running Node ` +
          `${process.version} on ${process.platform}-${process.arch}. ` +
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
    this.extractor = await pipeline('feature-extraction', this.model);
    return this.extractor;
  }

  /**
   * Embed texts in batches through the pipeline (one call per batch instead of one
   * per text), yielding to the event loop between batches so long builds stay
   * responsive and interruptible. Returns exactly one vector per input text.
   */
  async embed(texts: string[], kind: EmbedKind = 'passage'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.ensure();
    const size = Math.max(1, this.opts.batchSize ?? LocalEmbeddingProvider.BATCH_SIZE);
    const prefix = this.prefixes?.[kind] ?? '';
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const input = prefix ? batch.map((t) => prefix + t) : batch;
      const tensor = await extractor(input, { pooling: 'mean', normalize: true });
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
  // ZOTEUS_EMBEDDING_MODEL names the model of whichever provider is active, local included
  // (#43); the batch and delay dials apply to every provider that batches.
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
        logger?.warn(
          `ZOTEUS_EMBEDDINGS=local but ${TRANSFORMERS_MODULE} is not installed` +
            `${searchedFrom(config.transformersPath)}; using keyword-only search.`,
        );
        return { provider: null, configured: 'local', unavailable: missingTransformersHint(config) };
      }
      return {
        // The same knob as every other provider's: ZOTEUS_EMBEDDING_MODEL names the model of
        // whichever one is active, and unset means this provider's own default (#43).
        provider: new LocalEmbeddingProvider(config.embeddingModel || DEFAULT_LOCAL_MODEL, undefined, {
          transformersPath: config.transformersPath,
          dist: config.dist,
          modelCacheDir: join(config.dataDir, 'models'),
          batchSize: config.embedBatchSize,
          batchDelayMs: config.embedBatchDelayMs,
          prefixes: config.embeddingPrefixes,
        }),
        configured: 'local',
      };
  }
}

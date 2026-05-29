import type { ZoteusConfig } from '../../config.js';
import type { Logger } from '../../lib/logger.js';

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
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

/** Local on-device embeddings via @huggingface/transformers (optional, lazy). */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  private extractor: any;
  constructor(private readonly model = 'Xenova/all-MiniLM-L6-v2') {}

  private async ensure(): Promise<any> {
    if (this.extractor) return this.extractor;
    let transformers: any;
    try {
      transformers = await import('@huggingface/transformers' as any);
    } catch {
      throw new Error(
        'Local embeddings need the optional dependency. Install it with `npm i @huggingface/transformers`, or set ZOTEUS_EMBEDDINGS=off for keyword-only search.',
      );
    }
    this.extractor = await transformers.pipeline('feature-extraction', this.model);
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.ensure();
    const out: number[][] = [];
    for (const t of texts) {
      const tensor = await extractor(t, { pooling: 'mean', normalize: true });
      out.push(Array.from(tensor.data as Float32Array));
    }
    return out;
  }
}

/** OpenAI/Gemini embeddings (opt-in; data leaves the machine). */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  constructor(
    private readonly kind: 'openai' | 'gemini',
    private readonly apiKey: string,
  ) {
    this.name = kind;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (this.kind === 'openai') {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
      });
      if (!res.ok) throw new Error(`OpenAI embeddings failed (${res.status}).`);
      const json = (await res.json()) as any;
      return json.data.map((d: any) => d.embedding);
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((t) => ({ model: 'models/text-embedding-004', content: { parts: [{ text: t }] } })),
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini embeddings failed (${res.status}).`);
    const json = (await res.json()) as any;
    return json.embeddings.map((e: any) => e.values);
  }
}

/** Build the configured provider, or null for keyword-only search. */
export function createEmbeddingProvider(config: ZoteusConfig, logger?: Logger): EmbeddingProvider | null {
  switch (config.embeddings) {
    case 'off':
      return null;
    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        logger?.warn('ZOTEUS_EMBEDDINGS=openai but OPENAI_API_KEY is unset; using keyword-only search.');
        return null;
      }
      return new ApiEmbeddingProvider('openai', process.env.OPENAI_API_KEY);
    case 'gemini':
      if (!process.env.GEMINI_API_KEY) {
        logger?.warn('ZOTEUS_EMBEDDINGS=gemini but GEMINI_API_KEY is unset; using keyword-only search.');
        return null;
      }
      return new ApiEmbeddingProvider('gemini', process.env.GEMINI_API_KEY);
    case 'local':
    default:
      return new LocalEmbeddingProvider();
  }
}

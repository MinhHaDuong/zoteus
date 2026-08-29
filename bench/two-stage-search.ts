/**
 * Micro-benchmark for the two-stage vector search added in #30: binary codes scanned by
 * Hamming distance for a candidate pool, then an exact cosine rescore of that pool, against
 * the exact scan of every stored vector it replaces.
 *
 * Not part of the test suite. It writes a synthetic SQLite index of the shape the issue
 * reported (255,703 passages at 3072 dimensions is the real one, and 3.1 GB on disk), times
 * both paths over the same file, and measures how much of the exact ranking the coded path
 * recovers. Synthetic vectors are legitimate for the timing half: a scan costs the bytes it
 * reads and the arithmetic it runs, not what the numbers mean. Recall over random vectors
 * is a floor rather than a forecast, since real embeddings cluster and these do not.
 *
 * Usage:
 *   npx tsx bench/two-stage-search.ts [--vectors N] [--dim D] [--queries Q] [--limit L]
 *   npx tsx bench/two-stage-search.ts --vectors 255703 --dim 3072   # the reported shape
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSearchIndex } from '../src/features/search/sqlite-index.js';

interface Options {
  vectors: number;
  dim: number;
  queries: number;
  limit: number;
  clusters: number;
  keep: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { vectors: 50_000, dim: 768, queries: 9, limit: 10, clusters: 64, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => Number(argv[++i]);
    if (arg === '--vectors') opts.vectors = value();
    else if (arg === '--dim') opts.dim = value();
    else if (arg === '--queries') opts.queries = value();
    else if (arg === '--limit') opts.limit = value();
    else if (arg === '--clusters') opts.clusters = value();
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--help') {
      console.log(
        'usage: tsx bench/two-stage-search.ts [--vectors N] [--dim D] [--queries Q] [--limit L] [--clusters C] [--keep]',
      );
      process.exit(0);
    }
  }
  return opts;
}

/** A seeded LCG, so a run is reproducible and two runs are comparable. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function vector(next: () => number, dim: number): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = next() - 0.5;
  return v;
}

/**
 * One vector from a blend of two cluster centres plus noise, or a uniform one when the
 * corpus was asked for no clusters.
 *
 * Which of the two a corpus is built from decides what the recall figure means, and only
 * one of them means anything. Uniformly random vectors in a high-dimensional space are all
 * very nearly orthogonal to each other, so their "top 10" is a tie broken by noise and no
 * approximation can be expected to reproduce it: this bench measures 0.46 recall on such a
 * corpus at 3072 dimensions, which says nothing about a library. Real embeddings do not
 * look like that. They sit on a manifold where similarity varies continuously, so a query
 * has neighbours that are genuinely nearer than the rest and the codes have something to
 * find. A blend of two centres is the cheapest stand-in for that gradient; it is still a
 * caricature, which is why the recall figures worth trusting are the ones the issue thread
 * measured on real embeddings. The timing half of the bench does not care either way: a
 * scan costs the bytes it reads.
 */
function near(next: () => number, dim: number, centres: number[][], noise: number): number[] {
  if (!centres.length) return vector(next, dim);
  const a = centres[Math.floor(next() * centres.length)]!;
  const b = centres[Math.floor(next() * centres.length)]!;
  const mix = next();
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = a[i]! * mix + b[i]! * (1 - mix) + (next() - 0.5) * noise;
  return v;
}

const ms = (n: number): string => `${n.toFixed(1)} ms`;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** The protected ranker, called the way the fusion calls it. */
type Ranker = { vectorSearch(q: number[], k: number): Array<{ id: string; score: number }> };

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-bench-'));
  const jsonPath = join(dir, 'search-index.json');
  const dbPath = join(dir, 'search-index.sqlite');
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  console.log(
    `bench: ${opts.vectors} vectors x ${opts.dim} dims in ${opts.clusters || 'no'} clusters, ` +
      `${opts.queries} queries, limit ${opts.limit}`,
  );
  console.log(`file:  ${dbPath}`);

  const writer = new SqliteSearchIndex({ embedder: null, logger: quiet, path: dbPath, annEnabled: true });
  await writer.open();
  const store = writer as unknown as {
    putItem(key: string, title: string): void;
    putPassage(rec: { id: string; itemKey: string; title: string; text: string }): void;
    putVector(id: string, vector: number[]): void;
    finalizeVectors(): void;
  };

  const next = random(1234);
  // The stand-in for the structure real embeddings have; see `near`.
  const centres = Array.from({ length: opts.clusters }, () => vector(next, opts.dim));
  const noise = 0.3;
  let started = Date.now();
  for (let i = 0; i < opts.vectors; i++) {
    const key = `K${i}`;
    store.putItem(key, `Item ${i}`);
    store.putPassage({ id: `${key}#0`, itemKey: key, title: `Item ${i}`, text: `passage ${i}` });
    store.putVector(`${key}#0`, near(next, opts.dim, centres, noise));
  }
  await writer.save();
  console.log(`\nwrote ${opts.vectors} vectors in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // The codes, as a build writes them: one pass over the vectors, then a commit.
  started = Date.now();
  store.finalizeVectors();
  await writer.save();
  const codeSeconds = (Date.now() - started) / 1000;
  await writer.close();

  const words = Math.ceil(opts.dim / 32);
  console.log(
    `built codes in ${codeSeconds.toFixed(1)}s ` +
      `(${(((words * 4 * opts.vectors) / 1024 / 1024)).toFixed(1)} MB of codes, ` +
      `index file ${(statSync(dbPath).size / 1024 / 1024 / 1024).toFixed(2)} GB)`,
  );

  const open = async (annEnabled: boolean): Promise<Ranker> => {
    const index = new SqliteSearchIndex({ embedder: null, logger: quiet, path: dbPath, annEnabled });
    await index.open();
    return index as unknown as Ranker;
  };
  const coded = await open(true);
  const exact = await open(false);

  // Queries are drawn the way the corpus was, so a query lands somewhere in the subject
  // matter rather than in the empty space between all of it.
  const queries = Array.from({ length: opts.queries }, () => near(next, opts.dim, centres, noise));
  // Warm both: the coded path loads its codes into memory on the first query, and the
  // exact path warms the page cache the coded one would otherwise be blamed for missing.
  const warm = near(next, opts.dim, centres, noise);
  coded.vectorSearch(warm, opts.limit);
  exact.vectorSearch(warm, opts.limit);

  const codedMs: number[] = [];
  const exactMs: number[] = [];
  let recalled = 0;
  let wanted = 0;
  for (const q of queries) {
    // Round-robin, so a transient cannot land inside one candidate and not the other.
    let t = performance.now();
    const codedHits = coded.vectorSearch(q, opts.limit);
    codedMs.push(performance.now() - t);
    t = performance.now();
    const exactHits = exact.vectorSearch(q, opts.limit);
    exactMs.push(performance.now() - t);

    const truth = new Set(exactHits.map((h) => h.id));
    for (const hit of codedHits) if (truth.has(hit.id)) recalled++;
    wanted += truth.size;
  }

  const codedMedian = median(codedMs);
  const exactMedian = median(exactMs);
  console.log(`\n  exact scan       ${ms(exactMedian)}   (median of ${opts.queries})`);
  console.log(`  two-stage codes  ${ms(codedMedian)}   (${(exactMedian / codedMedian).toFixed(1)}x faster)`);
  console.log(`  recall@${opts.limit} vs the exact ranking: ${(recalled / wanted).toFixed(3)}`);

  await (coded as unknown as { close(): Promise<void> }).close();
  await (exact as unknown as { close(): Promise<void> }).close();
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`\nkept ${jsonPath.replace(/\.json$/, '.sqlite')}`);
}

await main();

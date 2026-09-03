/**
 * Index build limits, kept in their own module so `config.ts` can read the default without
 * importing `build.ts` and, with it, the search feature's runtime dependencies (persistence,
 * the full-text source, and whatever those grow into). Config stays a leaf that any module
 * can import.
 */

/**
 * Default cap on items per build. Not a hard ceiling: `ZOTEUS_INDEX_MAX_ITEMS` raises it
 * for libraries that outgrow it. The default stays where it was so an existing install
 * keeps its build time and index size unchanged.
 */
export const DEFAULT_INDEX_MAX_ITEMS = 5000;

/**
 * Default passages per embedding call: one transformers pipeline call locally, one HTTP
 * request through an API provider. `ZOTEUS_EMBED_BATCH_SIZE` overrides it, which matters
 * for API providers: a request carrying more tokens than the provider accepts is rejected
 * whole (OpenAI answers 400 above 300K tokens per request), and full-text passages reach
 * that ceiling far sooner than metadata ones.
 */
export const DEFAULT_EMBED_BATCH_SIZE = 32;

/**
 * Retries an embedding request gets after a rate limit or a server-side failure, before the
 * provider's error is finally thrown. `ZOTEUS_EMBED_MAX_RETRIES` overrides it; the wait
 * schedule it feeds lives in `embeddings.ts`.
 *
 * Five is chosen against that schedule rather than picked round: with the per-wait cap it
 * spends at most about two minutes waiting, which is long enough to ride out the bursts a
 * build produces when it sits near a tokens-per-minute ceiling, and short enough that a
 * provider which is genuinely down fails the job rather than hanging it. The whole point is
 * that a build costing hours of crawling and real money in embeddings must not be ended by
 * one transient 429 (#48).
 */
export const DEFAULT_EMBED_MAX_RETRIES = 5;

/**
 * Concurrent attachment full-text fetches during an index build, chosen by the API that is
 * serving the crawl. One number cannot be right for both, because the two paths fail in
 * opposite directions.
 *
 * The Web API is a fleet answering the whole world. It defends itself: a burst earns a 429
 * with a Backoff header the fetcher already honours, which costs latency and nothing else,
 * and the round trip to api.zotero.org is long enough that a single read in flight leaves
 * the crawl mostly idle. Four is what that path has always used.
 *
 * The local API is ONE desktop application. Its HTTP server shares a process with Zotero's
 * UI, its sync engine and its own PDF indexer, and it has no rate limiter: it answers
 * everything asked of it until it cannot. Four body reads held continuously for the length
 * of a full-text crawl was enough to stop Zotero 10 answering on port 23119 at all, 60 to
 * 90 seconds in, on a library of 358 extracted attachments (#39). The cost of that is much
 * worse than a slow crawl, because local-API reachability is a session-wide capability: the
 * moment it goes, every OTHER read and write in the session falls back to the Web API,
 * which is the slower, rate-limited path the crawl was avoiding, and a burst of it can
 * leave the cloud probe rate-limited for the rest of the session.
 *
 * 2 rather than 1 for the local path. A full-text read is almost entirely Zotero's own work
 * (a SQLite read plus JSON serialisation), so the crawl is bound by the app rather than by
 * the loopback hop, and serialising completely would roughly double a full-text build that
 * already runs for hours on a large library. 2 halves the standing load, which is the load
 * that saturates, while still keeping one request in flight while the previous response is
 * decoded and chunked. It is deliberately a starting point rather than a guarantee: see
 * SATURATED_FULLTEXT_CONCURRENCY for what happens when it turns out not to be enough.
 *
 * `ZOTEUS_INDEX_FULLTEXT_CONCURRENCY` overrides both, for anyone who has measured their own
 * machine and disagrees.
 */
export const DEFAULT_FULLTEXT_CONCURRENCY_LOCAL = 2;
export const DEFAULT_FULLTEXT_CONCURRENCY_CLOUD = 4;

/**
 * What a local-API full-text crawl drops to once Zotero has actually stopped answering.
 *
 * The cap above is a guess about somebody else's machine: how much headroom Zotero has
 * depends on the library, the disk, and whatever else the app is doing at the time. This is
 * the part that does not guess. The moment the local API is observed to have gone down
 * while a build is running, the crawl that is loading it stops overlapping requests
 * entirely and finishes one at a time, for the rest of the build. It never climbs back on
 * its own: an app that has just been driven into the ground is not the place to go looking
 * for the edge a second time, and the remaining cost is a slower tail on a build that was
 * already going to be slow.
 */
export const SATURATED_FULLTEXT_CONCURRENCY = 1;

/**
 * How many candidates the binary-code stage of a semantic query hands the exact rescore,
 * per vector hit the fusion asks for. The pool decides the accuracy of the whole two-stage
 * search: measured on real embeddings against the exact ranking, recall@30 was 0.884 at a
 * 4x pool, 0.953 at 8x and 0.986 at 16x, and rises with the width of the vectors (#30).
 * 16 buys the accurate end of that curve while still reading a few hundred vectors instead
 * of every one. `ZOTEUS_INDEX_ANN_OVERSAMPLE` overrides it.
 */
export const DEFAULT_ANN_OVERSAMPLE = 16;

/**
 * Floor on that candidate pool, so a small page still rescores a meaningful neighbourhood:
 * `limit:1` would otherwise ask the codes to order 48 rows on their own, which is exactly
 * what they are bad at. 500 rows cost about a millisecond to rescore.
 * `ZOTEUS_INDEX_ANN_MIN_CANDIDATES` overrides it.
 */
export const DEFAULT_ANN_MIN_CANDIDATES = 500;

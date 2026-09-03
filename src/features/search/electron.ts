/**
 * What running inside Electron changes about indexing, and why.
 *
 * Claude Desktop does not spawn a bundled extension as its own program. It forks an
 * Electron `utilityProcess` (`--utility-sub-type=node.mojom.NodeService`) and imports the
 * server into it, which is what the host means by "Using built-in Node.js for MCP server".
 * There, a build that reached the attachment full-text pass took the whole server process
 * down partway through, with no thrown error, no stack, no OOM report and nothing on
 * stderr, so the host saw only "Server transport closed unexpectedly" (#37).
 *
 * That is now diagnosed, by reproducing it outside Claude Desktop against the same library:
 * a prebuilt Electron 42.10.0, the app's own `mcp-runtime/nodeHost.js`, the same
 * `utilityProcess` fork, the same JSON-RPC bridge. The process dies of **SIGTRAP**, which
 * is Chromium's deliberate crash, not a fault. Chromium replaces the process allocator, and
 * an allocation it will not serve does not come back as null for the caller to handle: it
 * crashes the process immediately, before any handler, which is exactly why the death is
 * silent. The user's own apport report for the original crash says the same thing, on the
 * same utility sub-type: `Signal: 5 SIGTRAP`.
 *
 * What asks for that allocation is the local embedder. Three runs separate the causes:
 *
 * - Electron + `ZOTEUS_EMBEDDINGS=local` + full text: SIGTRAP, 14 s into a resumed build.
 * - Electron + no embedder + full text: the pass ran to completion, all 262 items and
 *   18287 body passages written to SQLite, peak RSS 283 MB. So the crawl, the concurrent
 *   attachment reads, the SQLite write path and the persist cadence are all exonerated.
 * - The same crash with no Zotero and no SQLite anywhere near it: load
 *   `@huggingface/transformers` in a bare `utilityProcess` and call the feature-extraction
 *   pipeline on batches of growing length. It embeds 32x512-char and 32x1200-char batches
 *   happily, then dies of SIGTRAP inside `extractor()` on a batch whose sequences reach the
 *   model's 512-token limit. The identical loop under standalone Node completes, at 2 GB
 *   RSS, having never been refused an allocation.
 *
 * So the size of ONE pipeline call is the whole story, and that size is batch x sequence².
 * `all-MiniLM-L6-v2` computes a batch x 12-head x seq x seq attention tensor: at 32
 * passages of 512 tokens that is about 400 MB in a single block, and onnxruntime's arena
 * asks for it in one piece. Metadata passages are chunked at 512 characters, roughly 128
 * tokens, so the same batch of 32 needs about 25 MB and never comes close. Full-text
 * passages are chunked at 1200 (FULLTEXT_CHUNK_SIZE) and are dense enough to reach the
 * token cap. That is the difference between the pass that always worked and the pass that
 * always died, and it is why the metadata pass embedding thousands of passages first proved
 * nothing about the native layer.
 *
 * The fix is therefore not a gate but a bound: under Electron the local embedder takes
 * fewer passages per call, so the largest tensor it ever asks for stays well inside what
 * Chromium's allocator will serve. With that in place the full-text build this issue was
 * filed about runs to completion inside a `utilityProcess`, on the same library, with the
 * local model in the same process.
 */

import { DEFAULT_EMBED_BATCH_SIZE } from './limits.js';

/**
 * The shape of `process.versions` these functions need. Its own type declares only the
 * components Node ships, which is the one thing `electron` will never be, so the runtime
 * value is read through this instead of through a property TypeScript refuses to see.
 */
export type RuntimeVersions = Readonly<Record<string, string | undefined>>;

const runtimeVersions = (): RuntimeVersions => process.versions as unknown as RuntimeVersions;

/**
 * Electron's version when this is Electron's Node, otherwise undefined.
 *
 * `process.versions.electron` is the signal because Electron sets it in every process it
 * runs, main, renderer and utility alike, and a standalone Node never has it. It is
 * injectable so callers can be tested from a runtime that is not Electron, which is every
 * runtime this test suite will ever run on.
 */
export function electronVersion(versions: RuntimeVersions = runtimeVersions()): string | undefined {
  const v = versions.electron;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Passages per local-embedder call under Electron.
 *
 * 8 rather than the 32 everywhere else, which puts the largest attention tensor one
 * pipeline call can ask for at roughly 100 MB instead of 400 MB: a quarter of the size that
 * was measured to crash, on a machine with 32 GB free, so the margin is not a guess about
 * how much memory is available but distance from an allocator's refusal.
 *
 * It is deliberately not 1. The crash threshold sits far above 8, the pass is CPU-bound
 * rather than memory-bound, and batching is what keeps a build that already runs for
 * minutes from running for hours; 8 buys a large margin at a cost the wall clock barely
 * registers.
 */
export const ELECTRON_LOCAL_EMBED_BATCH = 8;

/**
 * Passages the local embedder may hand the pipeline in one call, given what the user asked
 * for.
 *
 * Only the LOCAL provider is capped, and only under Electron. An API provider's batch is an
 * HTTP request body: it allocates nothing large in this process, its own ceiling is the
 * provider's token limit, and shrinking it would only multiply requests and spend.
 *
 * A user who set `ZOTEUS_EMBED_BATCH_SIZE` lower than the cap keeps their number: the cap
 * is a ceiling, not a target. One who set it higher loses it here, on purpose. The setting
 * exists to tune throughput, and there is no throughput past a process that has died.
 */
export function localEmbedBatchSize(
  configured: number | undefined,
  versions: RuntimeVersions = runtimeVersions(),
): number | undefined {
  if (!electronVersion(versions)) return configured;
  return Math.min(configured ?? DEFAULT_EMBED_BATCH_SIZE, ELECTRON_LOCAL_EMBED_BATCH);
}

/**
 * The line to log when the cap actually changed something, or undefined when it did not.
 *
 * Said out loud because it silently changes a number the user set, and because a desktop
 * user reading a slower build than they configured has no other way to learn why. Nothing
 * is logged when the cap is invisible, which is every run outside Electron and every run
 * whose configured batch was already small enough.
 */
export function localEmbedBatchNotice(
  configured: number | undefined,
  versions: RuntimeVersions = runtimeVersions(),
): string | undefined {
  const version = electronVersion(versions);
  if (!version) return undefined;
  const effective = localEmbedBatchSize(configured, versions);
  const asked = configured ?? DEFAULT_EMBED_BATCH_SIZE;
  if (effective === undefined || effective >= asked) return undefined;
  return (
    `Local embedding batches are capped at ${effective} passages here (asked for ${asked}): this server is ` +
    `running on Electron ${version}'s Node, where a single pipeline call large enough to need a gigabyte in one ` +
    'block is refused by Chromium\'s allocator and kills the process outright (#37). The build is a little ' +
    'slower and produces exactly the same index.'
  );
}

/*
 * There is deliberately no refusal here any more.
 *
 * 1.12.0 refused a full-text build under Electron outright, with an override
 * (`ZOTEUS_ALLOW_ELECTRON_FULLTEXT`) for anyone willing to risk it. That gate stood in for a
 * diagnosis nobody had: it named the one signal that correlated with the crash and offered
 * the headless workaround, which was the honest thing to ship while the cause was unknown.
 * The cause is now known and bounded, the build it refused runs to completion in the
 * environment it was refused in, and refusing the headline feature in the primary
 * distribution channel to avoid a crash that no longer happens would cost more than it
 * saves. Both the gate and its override are gone; an existing install that still sets the
 * variable is simply not reading it any more.
 */

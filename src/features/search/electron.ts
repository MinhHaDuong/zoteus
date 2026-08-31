/**
 * Whether a full-text index build may run in THIS process, and the explanation when it may
 * not.
 *
 * Claude Desktop no longer spawns a bundled extension as its own program: it runs the
 * server inside an Electron `UtilityProcess` on Electron's embedded Node. There, an
 * `action:"build"` that reaches the attachment full-text pass takes the whole server
 * process down partway through, with no thrown error, no stack, no OOM report and nothing
 * on stderr, so the host sees only "Server transport closed unexpectedly" (#37). The
 * identical build over the identical library, index file and environment runs to
 * completion under standalone Node, and the metadata pass, which embeds thousands of
 * passages through the same local model first, is never the one that dies.
 *
 * What that leaves is a failure below the JavaScript layer that only the full-text pass
 * reaches, on a runtime we do not ship and cannot reproduce against. It is NOT diagnosed:
 * the reporter's own suspicion (onnxruntime-node's native binary under Electron's Node
 * ABI) is explicitly unconfirmed, and Electron 42 ships no separate `node` binary to
 * isolate it with. So this module fixes nothing. It makes the failure survivable: the one
 * pass known to kill the process is refused up front, by name, with the workaround that
 * does work, instead of being discovered as a dead server ten minutes into a build.
 *
 * The gate is deliberately NOT narrowed to `ZOTEUS_EMBEDDINGS=local`. Narrowing it would
 * encode the onnxruntime theory as if it were established, and the full-text pass differs
 * from the metadata pass in several other ways that also reach native code (an order of
 * magnitude more passages, sustained concurrent HTTP against Zotero, minute-long SQLite
 * write transactions carrying far bulkier rows). Refusing on the one signal that actually
 * correlates, and offering an override, says only what is known.
 */

import type { ZoteusConfig } from '../../config.js';

/** Env var that runs the full-text pass under Electron anyway, at the user's risk. */
export const ELECTRON_FULLTEXT_OVERRIDE = 'ZOTEUS_ALLOW_ELECTRON_FULLTEXT';

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
 * injectable so the gate can be tested from a runtime that is not Electron, which is every
 * runtime this test suite will ever run on.
 */
export function electronVersion(versions: RuntimeVersions = runtimeVersions()): string | undefined {
  const v = versions.electron;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Why a full-text build must not start here, or undefined when it may.
 *
 * Written at the length of `missingTransformersHint` and for the same reason: the reader is
 * a desktop user with no stderr to consult, whose next move has to be in the sentence they
 * are shown.
 */
export function electronFulltextRefusal(
  config: Pick<ZoteusConfig, 'allowElectronFulltext'>,
  versions: RuntimeVersions = runtimeVersions(),
): string | undefined {
  if (config.allowElectronFulltext) return undefined;
  const version = electronVersion(versions);
  if (!version) return undefined;
  return (
    `Full-text indexing is refused here: this server is running on Electron ${version}'s Node (Claude Desktop runs ` +
    'a bundled extension inside a UtilityProcess), and there a build that reaches the attachment full-text pass ' +
    'kills the server process partway through with no error and no stack (#37). The same build completes under ' +
    'standalone Node, and the cause is not yet understood, so the pass is refused rather than attempted. ' +
    'Nothing was changed: the index on disk is exactly as it was. Three ways forward. ' +
    '(1) Build once outside Claude Desktop and read the result from inside it: run Zoteus from a terminal with the ' +
    'same ZOTEUS_DATA_DIR, call zotero_index action:"build" fulltext:true there, and Desktop picks the finished ' +
    'index up. zotero_index action:"update" then keeps it current from in here, body text included, because an ' +
    'update never enters this pass. ' +
    '(2) Index metadata only in here: pass fulltext:false to zotero_index, or turn the "Index PDF full text" ' +
    'extension setting (ZOTEUS_INDEX_FULLTEXT) off. Titles, abstracts, creators, tags, notes and annotations are ' +
    'all still indexed and searchable. ' +
    `(3) Try it anyway with ${ELECTRON_FULLTEXT_OVERRIDE}=true, accepting that the server may die mid-build; what ` +
    'it indexed before that point is kept, stays searchable, and action:"build" resumes from it.'
  );
}

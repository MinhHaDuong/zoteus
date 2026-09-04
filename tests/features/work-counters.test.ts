import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

/**
 * Phase 0+1 of ticket 0642: a durable, per-transaction `work.<stage>.<trigger>.<outcome>`
 * counter for the embed stage's `done` outcome (SPEC.md §5.2.8).
 *
 * The whole point of this ticket over the `metrics.ts` in-memory registry it deliberately
 * does not build on: a counter that only lives in process memory can prove R22's "pause
 * stops background work" clause by accident of timing, but can never prove "holds across
 * restart" with any rigor, because "reset to 0 and stayed 0" and "never wired" read the
 * same. Every case below is written to distinguish those two, red-first: a positive control
 * that shows the counter CAN move, a fresh CONNECTION (not merely a fresh read on the same
 * object) reading back what a prior one wrote, and a forced-rollback case proving the vector
 * write and its counter bump share one commit rather than two.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

const sqliteModule = nodeSqliteAvailable()
  ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  : undefined;
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

const ITEMS = [
  { key: 'AAAAAAAA', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks at scale' } },
  { key: 'BBBBBBBB', data: { itemType: 'book', title: 'Shallow water', abstractNote: 'tidal models of estuaries' } },
];

/** Counts every text it is asked to embed, and returns a distinct, deterministic vector. */
class CountingEmbedder implements EmbeddingProvider {
  readonly name = 'counting-fake';
  calls = 0;
  texts = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.texts += texts.length;
    return texts.map((t) => {
      let s = 2166136261;
      for (let i = 0; i < t.length; i++) s = (Math.imul(s ^ t.charCodeAt(i), 16777619) >>> 0) || 1;
      return Array.from({ length: 16 }, () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296 - 0.5;
      });
    });
  }
}

function tmpDbPath(name: string): string {
  return sqliteIndexPath(join(mkdtempSync(join(tmpdir(), `zoteus-${name}-`)), 'search-index.json'));
}

async function openIndex(path: string, opts: { embedder?: EmbeddingProvider | null } = {}) {
  const { SqliteSearchIndex } = await import('../../src/features/search/sqlite-index.js');
  const index = new SqliteSearchIndex({ embedder: opts.embedder ?? null, logger: silentLogger, path });
  await index.open();
  return index;
}

/** The row shape `work_counters` actually stores, read raw for a white-box assertion. */
function readWorkCounterRows(dbPath: string): Array<{ stage: string; trigger_kind: string; outcome: string; count: number }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT stage, trigger_kind, outcome, count FROM work_counters').all() as Array<{
      stage: string;
      trigger_kind: string;
      outcome: string;
      count: number;
    }>;
  } finally {
    db.close();
  }
}

describe('a durable work_counters table exists on every schema-3 database', () => {
  sqliteIt('a fresh database creates it directly, without going through the migration ladder', async () => {
    const path = tmpDbPath('work-fresh');
    const index = await openIndex(path);
    try {
      expect(readWorkCounterRows(path)).toEqual([]);
      const cols = new DatabaseSync(path, { readOnly: true });
      const names = (cols.prepare("SELECT name FROM pragma_table_info('work_counters')").all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
      cols.close();
      expect(names.sort()).toEqual(['count', 'outcome', 'stage', 'trigger_kind']);
    } finally {
      await index.close();
    }
  });

  sqliteIt('an older (schema 2) database gets it through the migration ladder, in place', async () => {
    // Ages a real index down to the pre-work-counters stamp, exactly the way
    // search-schema-migration.test.ts's own fixtures do: build with the CURRENT code
    // (which stamps 3), then rewrite the stamp by hand to the version this database would
    // have carried before this ticket. The table must not exist until the ladder runs.
    const path = tmpDbPath('work-migrated');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    await first.close();
    const aging = new DatabaseSync(path);
    aging.exec('DROP TABLE work_counters');
    aging.prepare("UPDATE meta SET value = '2' WHERE key = 'schemaVersion'").run();
    aging.close();
    expect(() => readWorkCounterRows(path)).toThrow();

    const second = await openIndex(path);
    try {
      expect(readWorkCounterRows(path)).toEqual([]);
      expect(second.buildStatus().storageNotice).toMatch(/upgraded in place from schema version 2 to 3/);
      expect(second.buildStatus().storageNotice).toMatch(/work_counters/);
      // The migration adds the table; it does not — and must not — retroactively invent a
      // count for vectors this database embedded before the counter existed. Fabricating
      // one would violate ticket 0642's own invariant against a dressed-up guess.
      expect(second.status().work).toBeUndefined();
    } finally {
      await second.close();
    }
  });
});

describe('the positive control: an embed pass CAN move the counter', () => {
  sqliteIt('a build that embeds N passages advances work.embed.build.done by exactly N', async () => {
    const path = tmpDbPath('work-positive-control');
    const embedder = new CountingEmbedder();
    const index = await openIndex(path, { embedder });
    try {
      await index.build(ITEMS);
      await index.save();
      const status = index.status();
      expect(status.vectors).toBeGreaterThan(0);
      expect(status.work).toBeDefined();
      expect(status.work?.embed?.build?.done).toBe(status.vectors);
    } finally {
      await index.close();
    }
  });

  sqliteIt('a coarse, honestly-named trigger: "build", not a fabricated finer classification', async () => {
    const path = tmpDbPath('work-coarse-trigger');
    const embedder = new CountingEmbedder();
    const index = await openIndex(path, { embedder });
    try {
      await index.build(ITEMS);
      await index.save();
      const work = index.status().work;
      expect(work).toBeDefined();
      expect(Object.keys(work!)).toEqual(['embed']);
      expect(Object.keys(work!.embed!)).toEqual(['build']);
      expect(Object.keys(work!.embed!.build!)).toEqual(['done']);
    } finally {
      await index.close();
    }
  });

  sqliteIt(
    'a salvaged (reused, not recomputed) vector does not bump the counter — only a real re-embed does',
    async () => {
      // The real mechanism the ticket's "don't double-count an item already embedded" case
      // maps onto: `adoptVector` (sqlite-index.ts) writes a reused vector straight through
      // `this.stmts.setVector`, deliberately NOT through `putVector`, precisely because
      // reusing a vector unchanged is SPEC.md's `noop`, not `done` — recomputed is the only
      // thing `done` means. This is the same salvage path
      // search-schema-migration.test.ts's "reuses a vector for a passage whose text is
      // unchanged" case exercises; this test reads the counter through it.
      const path = tmpDbPath('work-salvage-noop');
      const embedder = new CountingEmbedder();
      const first = await openIndex(path, { embedder });
      await first.build(ITEMS);
      await first.save();
      const builtVectors = first.status().vectors;
      const builtDone = first.status().work?.embed?.build?.done;
      await first.close();
      expect(builtDone).toBe(builtVectors);

      // Force a sideline (a schema stamp this build cannot reach), which arms vector
      // salvage from the moved-aside file.
      const aging = new DatabaseSync(path);
      aging.prepare("UPDATE meta SET value = '99' WHERE key = 'schemaVersion'").run();
      aging.close();

      const second = await openIndex(path, { embedder });
      try {
        expect(second.buildStatus().storageNotice).toMatch(/takes its vector from the moved-aside index/);
        // One item unchanged (its vector is salvaged, not recomputed); one item's text
        // changed (it must be re-embedded).
        const edited = [
          ITEMS[0],
          {
            key: 'BBBBBBBB',
            data: { itemType: 'book', title: 'Shallow water', abstractNote: 'a completely different subject' },
          },
        ];
        const embeddedBefore = embedder.texts;
        await second.build(edited);
        await second.save();
        const after = second.status();
        // Every passage has a vector again (one salvaged, one recomputed) ...
        expect(after.vectors).toBe(builtVectors);
        // ... but the counter only credits the one actually recomputed: strictly fewer
        // than the vector total, and it grew by exactly how many the embedder was really
        // called for — the salvaged one never rides along as a fabricated "done". The
        // sideline opened a genuinely NEW database file at this path (the old one moved
        // aside, salvage reading vector bytes out of it) — a fresh file's own ledger
        // starting at 0 and crediting only what IT recomputed, rather than inheriting
        // `builtDone` from a different file's history, is the honest answer: `builtDone`
        // describes work committed to a file this build never wrote to.
        const recomputed = embedder.texts - embeddedBefore;
        expect(recomputed).toBeGreaterThan(0);
        expect(recomputed).toBeLessThan(after.vectors);
        expect(after.work?.embed?.build?.done).toBe(recomputed);
      } finally {
        await second.close();
      }
    },
  );
});

describe('durability: a fresh CONNECTION, not merely a fresh read, sees what a prior one committed', () => {
  sqliteIt('closing the process and opening a brand-new connection to the same file reads back the same total', async () => {
    const path = tmpDbPath('work-durable-restart');
    const embedder = new CountingEmbedder();
    const first = await openIndex(path, { embedder });
    await first.build(ITEMS);
    await first.save();
    const committed = first.status().work?.embed?.build?.done;
    expect(committed).toBeGreaterThan(0);
    // The whole object this test exists to destroy: closing this connection is the
    // strongest in-process simulation of a process restart short of literally forking one.
    await first.close();

    // A brand-new SqliteSearchIndex instance — its own connection, its own in-process
    // state, nothing shared with `first` but the file on disk.
    const reopened = await openIndex(path, { embedder: new CountingEmbedder() });
    try {
      expect(reopened.status().work?.embed?.build?.done).toBe(committed);
    } finally {
      await reopened.close();
    }

    // And read raw, bypassing the object model entirely, as the harness's own
    // `bench/acceptance/durability.work_counters()` reads a target's status — the number
    // did not come from anything this process remembered.
    const raw = readWorkCounterRows(path);
    expect(raw).toEqual([{ stage: 'embed', trigger_kind: 'build', outcome: 'done', count: committed }]);
  });
});

describe('atomicity: the vector write and its counter bump commit together, or not at all', () => {
  sqliteIt('a commit that never happens leaves NEITHER the vector NOR the counter durable', async () => {
    // Forces the exact failure mode a process kill between the write and the fsync would
    // produce: `build()` (the test helper on `SearchIndexBase`) stages passages and vectors
    // into an open transaction but does not itself persist — every existing test in this
    // suite calls `.save()` afterwards, and that is deliberately the one call this test
    // breaks. `putVector`'s UPDATE and `bumpWorkCounter`'s INSERT already ran against this
    // connection by the time `.save()` reaches `flush()`'s `commit()`, so replacing that one
    // method is a genuine kill switch on the one shared commit, not a coincidence of two
    // independent ones happening to break together.
    const path = tmpDbPath('work-atomicity');
    const embedder = new CountingEmbedder();
    const index = await openIndex(path, { embedder });
    await index.build(ITEMS);
    const forced = new Error('forced: commit never runs');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (index as any).commit = () => {
      throw forced;
    };
    await expect(index.save()).rejects.toThrow(forced);
    // The transaction both writes went into is still open: `bumpWorkCounter`'s INSERT ran
    // (and reset the in-memory tally that guards against re-bumping it on a retry) before
    // the overridden `commit()` threw, so nothing here has been rolled back yet — it is
    // simply not committed either.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((index as any).inTransaction).toBe(true);

    // A second, independent connection while the first's transaction is still open: SQLite's
    // own isolation is the thing a process-kill test would otherwise have to simulate by
    // literally killing a process. Neither the vector nor the counter is visible here,
    // because neither was ever committed.
    const outside = new DatabaseSync(path, { readOnly: true });
    try {
      const vectors = (outside.prepare('SELECT COUNT(*) AS n FROM passages WHERE vector IS NOT NULL').get() as { n: number }).n;
      const counters = (outside.prepare('SELECT COUNT(*) AS n FROM work_counters').get() as { n: number }).n;
      expect(vectors).toBe(0);
      expect(counters).toBe(0);
    } finally {
      outside.close();
    }

    // Discard the never-committed transaction exactly as a crashed process's connection
    // loss would (SQLite rolls back whatever an unclosed transaction never committed).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (index as any).db as InstanceType<typeof DatabaseSync>;
    raw.exec('ROLLBACK');
    raw.close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (index as any).db = undefined;

    // A genuinely fresh connection — the harness's own durability check — confirms it:
    // NEITHER write survived, together, which is the only acceptable outcome short of BOTH
    // surviving together. One without the other is the failure this ticket exists to rule
    // out, and this test cannot produce it no matter which single method is broken.
    const reopened = await openIndex(path, { embedder: new CountingEmbedder() });
    try {
      const status = reopened.status();
      expect(status.vectors).toBe(0);
      expect(status.work).toBeUndefined();
    } finally {
      await reopened.close();
    }
  });
});

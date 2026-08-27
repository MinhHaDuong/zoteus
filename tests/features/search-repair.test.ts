import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, openSync, writeSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import { repairSearchIndex } from '../../src/features/search/repair.js';
import { isQuerySyntaxError, SearchIndexUnreadableError } from '../../src/features/search/store-faults.js';

/**
 * #20 gave a damaged index the right floor: refuse, and say which files to delete. #21 is
 * the ceiling. The people most likely to meet a damaged index are desktop `.mcpb` installs,
 * and `rm ~/.../search-index.sqlite` is not a recovery path for someone with no shell open.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;
const ITEM = { key: 'A', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks' } };

const tmpJson = (name: string) => join(mkdtempSync(join(tmpdir(), `zoteus-${name}-`)), 'search-index.json');

const open = (jsonPath: string, backend: 'sqlite' | 'memory' = 'sqlite') =>
  createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath });

/** Overwrite page 3, header intact: SQLite opens the file and fails when it reads it. */
function scribble(dbPath: string): void {
  const fd = openSync(dbPath, 'r+');
  writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 8192);
  closeSync(fd);
}

/** A tool context with only what the repair touches, plus a real reopen. */
function makeCtx(jsonPath: string, backend: 'sqlite' | 'memory') {
  const ctx: any = { searchIndexPath: jsonPath, logger: silentLogger };
  ctx.reopenSearchIndex = async () => {
    await ctx.search.close().catch(() => {});
    ctx.search = await open(jsonPath, backend);
    return ctx.search;
  };
  return ctx;
}

describe('repairing an index that cannot be read', () => {
  sqliteIt('deletes the damaged database and its sidecars, then opens a fresh one', async () => {
    const jsonPath = tmpJson('repair');
    const dbPath = sqliteIndexPath(jsonPath);
    const built = await open(jsonPath);
    await built.build([ITEM]);
    await built.save();
    await built.close();
    scribble(dbPath);

    const ctx = makeCtx(jsonPath, 'sqlite');
    ctx.search = await open(jsonPath);
    expect(ctx.search.storeFault).toBeTruthy();

    const report = await repairSearchIndex(ctx);
    expect(report.removed).toContain(dbPath);
    expect(ctx.search.storeFault).toBeUndefined();
    // A fresh index, not the old one patched: the version stamp lived inside the file that
    // went, so there is nothing left claiming to be up to date.
    expect(ctx.search.isEmpty).toBe(true);
    expect(ctx.search.buildStatus().libraryVersion).toBe(0);
    await ctx.search.close();
  });

  sqliteIt('refuses to repair an index that reports nothing wrong', async () => {
    const jsonPath = tmpJson('healthy');
    const ctx = makeCtx(jsonPath, 'sqlite');
    ctx.search = await open(jsonPath);
    await expect(repairSearchIndex(ctx)).rejects.toThrow(/nothing to repair/i);
    await ctx.search.close();
  });

  sqliteIt('leads with the tool call and keeps rm as the fallback', async () => {
    // The refusal is the whole of what a caller has to go on, and `rm` stops being the
    // first thing to try the moment an explicit build can do the job.
    const jsonPath = tmpJson('message');
    const built = await open(jsonPath);
    await built.build([ITEM]);
    await built.save();
    await built.close();
    scribble(sqliteIndexPath(jsonPath));
    const index = await open(jsonPath);
    const msg = index.storeFault!.message;
    expect(msg.indexOf('action:"build"')).toBeLessThan(msg.indexOf('rm '));
    expect(msg).toMatch(/never repaired automatically/);
    await index.close();
  });
});

describe('a JSON artifact that cannot be read', () => {
  it('refuses instead of reading as an empty library', async () => {
    const jsonPath = tmpJson('truncated');
    const built = await open(jsonPath, 'memory');
    await built.build([ITEM]);
    await built.save();
    const half = readFileSync(jsonPath, 'utf8');
    writeFileSync(jsonPath, half.slice(0, Math.floor(half.length / 2)));

    const index = await open(jsonPath, 'memory');
    expect(index.storeFault).toBeInstanceOf(SearchIndexUnreadableError);
    // Not "empty": an empty index invites an automatic first build, and reads to a caller
    // exactly like a library holding nothing.
    expect(index.isEmpty).toBe(false);
    await expect(index.query('learning')).rejects.toThrow(/cannot be read/);
  });

  it('never writes its emptiness back over the artifact', async () => {
    // `loadFromJSON` resets before it parses, so a failed load leaves the index holding
    // nothing — and the shutdown flush used to write that nothing straight over the user's
    // file, destroying the index the failure was reporting on.
    const jsonPath = tmpJson('nodestroy');
    const built = await open(jsonPath, 'memory');
    await built.build([ITEM]);
    await built.save();
    const whole = readFileSync(jsonPath, 'utf8');
    const truncated = whole.slice(0, Math.floor(whole.length / 2));
    writeFileSync(jsonPath, truncated);

    const index = await open(jsonPath, 'memory');
    await expect(index.save()).rejects.toThrow(/cannot be read/);
    expect(readFileSync(jsonPath, 'utf8')).toBe(truncated);
  });

  it('is repaired by an explicit build, like the SQLite one', async () => {
    const jsonPath = tmpJson('jsonrepair');
    const built = await open(jsonPath, 'memory');
    await built.build([ITEM]);
    await built.save();
    writeFileSync(jsonPath, '{"documents": [');

    const ctx = makeCtx(jsonPath, 'memory');
    ctx.search = await open(jsonPath, 'memory');
    expect(ctx.search.storeFault).toBeTruthy();
    const report = await repairSearchIndex(ctx);
    expect(report.removed).toEqual([jsonPath]);
    expect(existsSync(jsonPath)).toBe(false);
    expect(ctx.search.storeFault).toBeUndefined();
  });

  it('treats a missing artifact as a first run, not as damage', async () => {
    const index = await open(tmpJson('fresh'), 'memory');
    expect(index.storeFault).toBeUndefined();
    expect(index.isEmpty).toBe(true);
  });
});

describe('isQuerySyntaxError', () => {
  // The catch in keywordSearch was written for one condition and implemented as
  // swallow-everything, so a broken index answered "no matches" forever and read as an
  // empty library. Every one of these is errcode 1, so only the message can separate them.
  const err = (message: string, errcode = 1) => Object.assign(new Error(message), { errcode });

  it('claims the ways SQLite rejects the match string we built', () => {
    expect(isQuerySyntaxError(err('fts5: syntax error near "AND"'))).toBe(true);
    expect(isQuerySyntaxError(err('unknown special query: bogus'))).toBe(true);
    expect(isQuerySyntaxError(err('no such column: nosuchcol'))).toBe(true);
  });

  it('disclaims the failures that mean the index itself is broken', () => {
    // Each of these used to come back as an empty result set.
    expect(isQuerySyntaxError(err('no such table: passages'))).toBe(false);
    expect(isQuerySyntaxError(err('disk I/O error', 10))).toBe(false);
    expect(isQuerySyntaxError(err('database is locked', 5))).toBe(false);
    expect(isQuerySyntaxError(err('interrupted', 9))).toBe(false);
  });
});

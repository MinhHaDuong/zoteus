import { describe, it, expect } from 'vitest';
import { classifyError, describeShape } from '../../src/lib/usage/event.js';
import { aggregate, dayOf, percentile } from '../../src/lib/usage/rollup.js';

describe('describeShape', () => {
  it('keeps names, types and sizes, and never a string value', () => {
    const shape = JSON.parse(
      describeShape({
        q: 'systematic review',
        limit: 25,
        top: false,
        keys: ['A', 'B', 'C'],
        filters: { tag: 'to-read' },
        missing: undefined,
        empty: null,
      })!,
    );
    expect(shape).toEqual({
      q: 'string(17)',
      limit: 'number',
      top: false,
      keys: 'array(3)',
      filters: 'object(1)',
    });
    // Nested values are counted, never described: `to-read` must not survive one level down.
    expect(JSON.stringify(shape)).not.toContain('to-read');
    expect(JSON.stringify(shape)).not.toContain('systematic');
  });

  it('has nothing to say about a non-object or an empty one', () => {
    expect(describeShape(undefined)).toBeUndefined();
    expect(describeShape('a string')).toBeUndefined();
    expect(describeShape(['a', 'b'])).toBeUndefined();
    expect(describeShape({})).toBeUndefined();
    expect(describeShape({ absent: undefined })).toBeUndefined();
  });
});

describe('classifyError', () => {
  it('names a cause without quoting a message', () => {
    expect(classifyError(Object.assign(new Error('Access denied'), { status: 403 }))).toBe(
      'zotero_4xx',
    );
    expect(classifyError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(
      'zotero_4xx',
    );
    expect(classifyError(Object.assign(new Error('boom'), { status: 502 }))).toBe('zotero_5xx');
    expect(classifyError(Object.assign(new Error('bad'), { name: 'ZodError' }))).toBe('validation');
    expect(classifyError(Object.assign(new Error('db'), { code: 'ERR_SQLITE_ERROR' }))).toBe(
      'sqlite',
    );
    expect(classifyError(Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }))).toBe('timeout');
    expect(classifyError(new Error('plain'))).toBe('error');
    for (const kind of ['zotero_4xx', 'zotero_5xx', 'validation', 'error'])
      expect(kind).not.toContain(' ');
  });
});

describe('rollup helpers', () => {
  it('takes the nearest rank, so a percentile is a duration that happened', () => {
    const sorted = [10, 20, 30, 40, 100];
    expect(percentile(sorted, 0.5)).toBe(30);
    expect(percentile(sorted, 0.95)).toBe(100);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('groups by day, kind, name and user in UTC', () => {
    const base = Date.UTC(2026, 8, 3, 23, 30);
    const rows = aggregate([
      { ts: base, kind: 'tool', name: 'a', userId: 1, ok: true, ms: 10 },
      { ts: base, kind: 'tool', name: 'a', userId: 1, ok: false, ms: 30 },
      { ts: base, kind: 'tool', name: 'a', userId: 2, ok: true, ms: 50 },
      // An hour later is the next UTC day, and must not join the group above.
      { ts: base + 3_600_000, kind: 'tool', name: 'a', userId: 1, ok: true, ms: 70 },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.userId === 1 && r.day === '2026-09-03')).toMatchObject({
      calls: 2,
      errors: 1,
      msSum: 40,
      msMax: 30,
    });
    expect(dayOf(base + 3_600_000)).toBe('2026-09-04');
  });
});

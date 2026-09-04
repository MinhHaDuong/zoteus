import { describe, it, expect, vi } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tagAudit from '../../src/tools/tag-audit.js';

function ctx(over: Record<string, unknown> = {}) {
  return {
    // A stdio-shaped caller: the operator owns the machine, so vocabulary_path is not
    // confined to the data directory. See tests/lib/caller-path.test.ts for the confined case.
    config: { dataDir: tmpdir() },
    remoteCaller: false,
    ...over,
    web: {
      listTags: vi.fn(async () => ({
        data: [
          { tag: 'ml', meta: { type: 0, numItems: 10 } },
          { tag: 'legacy', meta: { type: 0, numItems: 2 } }, // manual ⇒ off-taxonomy (not auto-bucketed)
        ],
        totalResults: 2,
        lastModifiedVersion: 1,
      })),
    },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      searchItems: vi.fn(async () => ({
        data: [
          { key: 'I1', data: { title: 'A', tags: [{ tag: 'ml' }] } },
          { key: 'I2', data: { title: 'B', tags: [{ tag: 'legacy' }] } },
        ],
        totalResults: 2,
        lastModifiedVersion: 1,
      })),
    },
  } as any;
}

const vocabulary = {
  tags: [{ name: 'ml', tier: 'topic' }],
  tiers: [{ name: 'topic', required: true }],
};

describe('zotero_tag_audit', () => {
  it('is read-only', () => {
    expect(tagAudit.annotations?.readOnlyHint).toBe(true);
  });

  it('reports off-taxonomy tags and items missing a required tier', async () => {
    const res = await tagAudit.handler({ vocabulary }, ctx());
    const sc = res.structuredContent as any;
    expect(sc.offTaxonomy.map((t: any) => t.name)).toContain('legacy');
    expect(sc.missingByTier[0].tier).toBe('topic');
    expect(sc.missingByTier[0].items.map((i: any) => i.key)).toEqual(['I2']);
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('legacy');
  });

  it('errors when neither vocabulary nor vocabulary_path is given', async () => {
    const res = await tagAudit.handler({}, ctx());
    expect(res.isError).toBe(true);
  });

  it('refuses a vocabulary_path outside the data directory when the caller is remote', async () => {
    const res = await tagAudit.handler(
      { vocabulary_path: '/etc/passwd' },
      ctx({ config: { dataDir: join(tmpdir(), 'zoteus-data') }, remoteCaller: true }),
    );
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('vocabulary_path');
  });

  it('returns a friendly error when vocabulary_path is malformed JSON', async () => {
    const path = join(tmpdir(), `zoteus-vocab-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(path, '{ this is not: valid json,, }', 'utf8');
    try {
      const res = await tagAudit.handler({ vocabulary_path: path }, ctx());
      expect(res.isError).toBe(true);
      const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
      expect(text).toContain('not valid JSON');
    } finally {
      await unlink(path).catch(() => {});
    }
  });
});

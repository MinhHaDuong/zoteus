import { describe, it, expect } from 'vitest';
import { auditOffTaxonomy, auditMissingTiers, type Vocabulary } from '../../src/features/tags/audit.js';

const vocab: Vocabulary = {
  tags: [
    { name: 'ml', tier: 'topic' },
    { name: 'robotics', tier: 'topic' },
    { name: 'SQ1', tier: 'subquestion' },
  ],
  tiers: [
    { name: 'topic', required: true },
    { name: 'subquestion', required: false },
  ],
};

describe('auditOffTaxonomy', () => {
  it('flags library tags not in the vocabulary and buckets auto tags', () => {
    const lib = [
      { name: 'ml', numItems: 10, auto: false },
      { name: 'legacy', numItems: 2, auto: false },
      { name: 'pdf-keyword', numItems: 5, auto: true },
    ];
    const r = auditOffTaxonomy(lib, vocab, false);
    expect(r.offTaxonomy.map((t) => t.name)).toEqual(['legacy']);
    expect(r.autoTags.map((t) => t.name)).toEqual(['pdf-keyword']);
  });

  it('includes auto tags in off-taxonomy when include_auto is true', () => {
    const lib = [{ name: 'pdf-keyword', numItems: 5, auto: true }];
    const r = auditOffTaxonomy(lib, vocab, true);
    expect(r.offTaxonomy.map((t) => t.name)).toEqual(['pdf-keyword']);
    expect(r.autoTags).toHaveLength(0);
  });
});

describe('auditMissingTiers', () => {
  it('lists items missing a tag from each required tier', () => {
    const items = [
      { key: 'I1', title: 'has topic', tags: ['ml'] },
      { key: 'I2', title: 'no topic', tags: ['SQ1'] },
    ];
    const r = auditMissingTiers(items, vocab);
    expect(r).toHaveLength(1); // only the required 'topic' tier
    expect(r[0].tier).toBe('topic');
    expect(r[0].items.map((i) => i.key)).toEqual(['I2']);
  });
});

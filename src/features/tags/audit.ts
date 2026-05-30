export interface VocabTag {
  name: string;
  tier?: string;
}
export interface VocabTier {
  name: string;
  required?: boolean;
}
export interface Vocabulary {
  tags: VocabTag[];
  tiers?: VocabTier[];
}

export interface TagInfo {
  name: string;
  numItems?: number;
  auto?: boolean;
}
export interface AuditItem {
  key: string;
  title?: string;
  tags: string[];
}

export interface TagEntry {
  name: string;
  numItems?: number;
}
export interface MissingTierEntry {
  tier: string;
  itemCount: number;
  items: Array<{ key: string; title?: string }>;
}

export function auditOffTaxonomy(
  libraryTags: TagInfo[],
  vocab: Vocabulary,
  includeAuto: boolean,
): { offTaxonomy: TagEntry[]; autoTags: TagEntry[] } {
  const vocabNames = new Set(vocab.tags.map((t) => t.name));
  const offTaxonomy: TagEntry[] = [];
  const autoTags: TagEntry[] = [];
  for (const t of libraryTags) {
    if (vocabNames.has(t.name)) continue;
    const entry: TagEntry = { name: t.name, numItems: t.numItems };
    if (t.auto && !includeAuto) autoTags.push(entry);
    else offTaxonomy.push(entry);
  }
  return { offTaxonomy, autoTags };
}

export function auditMissingTiers(items: AuditItem[], vocab: Vocabulary): MissingTierEntry[] {
  const required = (vocab.tiers ?? []).filter((t) => t.required);
  const tagTier = new Map(vocab.tags.map((t) => [t.name, t.tier] as const));
  return required.map((tier) => {
    const missing = items.filter((it) => !it.tags.some((tg) => tagTier.get(tg) === tier.name));
    return { tier: tier.name, itemCount: missing.length, items: missing.map((m) => ({ key: m.key, title: m.title })) };
  });
}

import { TICK_PAGE_SIZE } from '../../src/features/search/conductor/reconcile-tick.js';
import type { ReplayLocalApi } from './local-api-replay.js';

/**
 * Fixture (b) of ticket 0551: a synthetic Zotero library, small enough to reason about
 * and shaped like the one the measurements were taken on.
 *
 * It models the property that makes Zotero freshness hard, and that a hand-written
 * two-item fake hides: **two independent version sequences**. Editing an item moves the
 * item sequence and not the full-text one; Zotero extracting a PDF for the first time
 * moves the full-text sequence and touches no item version at all. Everything the
 * reconcile tick does follows from that split.
 *
 * The library holds, deliberately:
 *
 * - 50 top-level items on strictly increasing `dateAdded`, one day apart, so
 *   newest-first ordering is decidable rather than approximate;
 * - child notes and annotations, because R16's own-words class is a second pass over
 *   item types and a library with only top-level records cannot exercise it (annotations
 *   hang under attachments, as they do in Zotero, not under the parent item);
 * - one monster attachment, whose extracted text is 500 passage-sized blocks — the
 *   15 000-page PDF of §5.2.3 in miniature, and the reason bands exist;
 * - one near-empty HTML snapshot, whose extraction is chrome and almost no text, which
 *   is the case where a passage census reads 5 rather than 35;
 * - a version-0 residue: attachments whose full-text version is 0 because Zotero
 *   extracted them locally and stamped nothing. 584 of 8 037 measured entries are like
 *   this, and they are invisible to an equality comparison (SPEC.md §5.2.4).
 *
 * `assertInvariants()` is the fixture's own gate. A fixture nothing checks is a fixture
 * that can drift into agreeing with whatever bug it is meant to catch, so `corrupt()`
 * exists beside it: it breaks one property deliberately, and the positive-control test
 * asserts the gate notices.
 */

export interface SyntheticLibraryOptions {
  itemCount?: number;
  /** Blocks of text in the monster attachment. 500 is the ticket's figure. */
  monsterPassages?: number;
  /** `dateAdded` of the oldest item; each later item is one day newer. */
  baseDate?: string;
}

interface ItemRecord {
  key: string;
  itemType: string;
  version: number;
  dateAdded: string;
  parentItem?: string;
  title?: string;
  contentType?: string;
}

interface FulltextRecord {
  version: number;
  content: string;
  indexedPages: number;
  totalPages: number;
}

const DAY_MS = 86_400_000;

export class SyntheticLibrary {
  /** Zotero's item sequence. Monotone, and the one `?since=` is a legitimate cursor on. */
  itemVersion = 0;

  /**
   * Zotero's full-text sequence. Separate on purpose, and NOT monotone for a local scope:
   * `extractLocally` stamps 0 on it, which is the residue the tick has to disclose.
   */
  fulltextVersion = 0;

  private readonly items = new Map<string, ItemRecord>();
  private readonly fulltext = new Map<string, FulltextRecord>();
  private readonly opts: Required<SyntheticLibraryOptions>;

  /** The two attachments the design's edge cases are named after. */
  readonly monsterAttachment = 'ATTAMNST';
  readonly emptySnapshot = 'ATTASNAP';

  constructor(options: SyntheticLibraryOptions = {}) {
    this.opts = {
      itemCount: options.itemCount ?? 50,
      monsterPassages: options.monsterPassages ?? 500,
      baseDate: options.baseDate ?? '2026-01-01T00:00:00Z',
    };
    this.build();
  }

  // ------------------------------------------------------------------ shape

  private build(): void {
    const base = Date.parse(this.opts.baseDate);
    for (let i = 1; i <= this.opts.itemCount; i++) {
      const key = `ITEM${String(i).padStart(4, '0')}`;
      this.put({
        key,
        itemType: 'journalArticle',
        dateAdded: new Date(base + i * DAY_MS).toISOString(),
        title: `Synthetic article ${i}`,
      });
    }

    // Own words: notes under the ten newest items, annotations under their attachments.
    for (let i = 1; i <= 10; i++) {
      const parent = `ITEM${String(i).padStart(4, '0')}`;
      this.put({
        key: `NOTE${String(i).padStart(4, '0')}`,
        itemType: 'note',
        dateAdded: new Date(base + i * DAY_MS + 3_600_000).toISOString(),
        parentItem: parent,
      });
    }

    // Thirty PDFs. Zotero has extracted twenty of them; the rest were never opened, which
    // is why an item-sequence sweep alone never learns their text exists.
    for (let i = 1; i <= 30; i++) {
      const parent = `ITEM${String(i).padStart(4, '0')}`;
      const key = `ATTA${String(i).padStart(4, '0')}`;
      this.put({
        key,
        itemType: 'attachment',
        contentType: 'application/pdf',
        dateAdded: new Date(base + i * DAY_MS + 7_200_000).toISOString(),
        parentItem: parent,
      });
      if (i <= 20) {
        // Two of the twenty carry the version-0 residue: Zotero extracted them itself and
        // stamped nothing, so their version can never distinguish a re-extraction.
        if (i <= 2) this.extractLocally(key, block(`attachment ${i}`, 4));
        else this.extract(key, block(`attachment ${i}`, 4));
      }
    }

    for (let i = 1; i <= 5; i++) {
      const attachment = `ATTA${String(i).padStart(4, '0')}`;
      this.put({
        key: `ANNO${String(i).padStart(4, '0')}`,
        itemType: 'annotation',
        dateAdded: new Date(base + i * DAY_MS + 10_800_000).toISOString(),
        parentItem: attachment,
      });
    }

    // The monster: one attachment whose text is 500 passage-sized blocks.
    this.put({
      key: this.monsterAttachment,
      itemType: 'attachment',
      contentType: 'application/pdf',
      dateAdded: new Date(base + 25 * DAY_MS + 14_400_000).toISOString(),
      parentItem: 'ITEM0025',
    });
    this.extract(this.monsterAttachment, block('monster', this.opts.monsterPassages), {
      indexedPages: 1500,
      totalPages: 1500,
    });

    // The near-empty snapshot: an HTML page whose extraction is almost all chrome.
    this.put({
      key: this.emptySnapshot,
      itemType: 'attachment',
      contentType: 'text/html',
      dateAdded: new Date(base + 26 * DAY_MS + 14_400_000).toISOString(),
      parentItem: 'ITEM0026',
    });
    this.extract(this.emptySnapshot, 'Skip to content', { indexedPages: 1, totalPages: 1 });
  }

  private put(rec: Omit<ItemRecord, 'version'>): string {
    this.itemVersion++;
    this.items.set(rec.key, { ...rec, version: this.itemVersion });
    return rec.key;
  }

  // --------------------------------------------------------------- mutation

  /** A new top-level item, newer than everything already here. */
  addItem(title = 'Newly added'): string {
    const n = [...this.items.keys()].filter((k) => k.startsWith('ITEM')).length + 1;
    const base = Date.parse(this.opts.baseDate);
    return this.put({
      key: `ITEM${String(n).padStart(4, '0')}`,
      itemType: 'journalArticle',
      dateAdded: new Date(base + n * DAY_MS).toISOString(),
      title,
    });
  }

  /** An edit: the item sequence moves, the full-text sequence does not. */
  touch(key: string): number {
    const item = this.items.get(key);
    if (!item) throw new Error(`no item ${key}`);
    this.itemVersion++;
    item.version = this.itemVersion;
    return item.version;
  }

  /**
   * A deletion. The local API has no /deleted endpoint, so nothing announces this — the
   * only route to it is subtracting a fresh census from the stored one. Recursive, as
   * Zotero is: deleting an item takes its attachments, and their annotations with them.
   */
  remove(key: string): void {
    if (!this.items.delete(key)) throw new Error(`no item ${key}`);
    this.fulltext.delete(key);
    for (const [k, v] of [...this.items]) if (v.parentItem === key) this.remove(k);
  }

  /**
   * Zotero extracts (or re-extracts) an attachment on the synced sequence: the full-text
   * version moves and the item version does not. This is the case the tick catches.
   */
  extract(
    key: string,
    content: string,
    meta: { indexedPages?: number; totalPages?: number } = {},
  ): number {
    if (!this.items.has(key)) throw new Error(`no attachment ${key}`);
    this.fulltextVersion++;
    this.fulltext.set(key, {
      version: this.fulltextVersion,
      content,
      indexedPages: meta.indexedPages ?? 4,
      totalPages: meta.totalPages ?? 4,
    });
    return this.fulltextVersion;
  }

  /**
   * Zotero extracts locally and stamps version 0, as it does for text it produced itself.
   * Repeating this changes the stored text and moves nothing an equality test can see —
   * SPEC.md §5.2.4's version-0 residue, resolution (ii): accepted, disclosed staleness.
   */
  extractLocally(key: string, content: string): void {
    if (!this.items.has(key)) throw new Error(`no attachment ${key}`);
    const prev = this.fulltext.get(key);
    this.fulltext.set(key, {
      version: 0,
      content,
      indexedPages: prev?.indexedPages ?? 4,
      totalPages: prev?.totalPages ?? 4,
    });
  }

  /** Replacing the file: the ATTACHMENT ITEM's version moves, which is resolution (i). */
  replaceFile(key: string, content: string): void {
    this.touch(key);
    this.extractLocally(key, content);
  }

  // ------------------------------------------------------------------ reads

  itemVersionsMap(since = 0): Record<string, number> {
    const out: Record<string, number> = {};
    for (const item of this.items.values()) if (item.version > since) out[item.key] = item.version;
    return out;
  }

  itemsSince(since = 0): unknown[] {
    return [...this.items.values()]
      .filter((i) => i.version > since)
      .map((i) => ({
        key: i.key,
        version: i.version,
        data: {
          key: i.key,
          version: i.version,
          itemType: i.itemType,
          dateAdded: i.dateAdded,
          dateModified: i.dateAdded,
          ...(i.title ? { title: i.title } : {}),
          ...(i.parentItem ? { parentItem: i.parentItem } : {}),
          ...(i.contentType ? { contentType: i.contentType } : {}),
        },
      }));
  }

  fulltextCensusMap(since = 0): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, ft] of this.fulltext) if (since === 0 || ft.version > since) out[key] = ft.version;
    return out;
  }

  fulltextFor(key: string): FulltextRecord | undefined {
    return this.fulltext.get(key);
  }

  item(key: string): ItemRecord | undefined {
    return this.items.get(key);
  }

  keys(): string[] {
    return [...this.items.keys()];
  }

  // -------------------------------------------------------------- the wire

  /**
   * Register the whole library as canned responses on a replay fake.
   *
   * A cassette is a snapshot, so this is called again after every mutation: routes are
   * overwritten, never appended to. Every `since` value from 0 to the current sequence
   * head is registered, so a caller resuming from any watermark finds an answer rather
   * than a strict-mode throw it would have to read as a bug.
   */
  install(replay: ReplayLocalApi, prefix = '/users/0'): void {
    replay.clear();
    for (let v = 0; v <= this.itemVersion; v++) {
      const versions = this.itemVersionsMap(v);
      const query = v === 0 ? 'format=versions' : `since=${v}&format=versions`;
      replay.put(`${prefix}/items?${query}`, {
        body: versions,
        headers: {
          'total-results': String(Object.keys(versions).length),
          'last-modified-version': String(this.itemVersion),
          'zotero-server-id': 'synthetic-server',
        },
      });
      // The item read the tick actually issues is paged, so every page it would ask for
      // is canned — including the empty one past the end, which is what stops the loop
      // when the delta happens to be an exact multiple of the page size.
      const data = this.itemsSince(v);
      const headers = {
        'total-results': String(data.length),
        'last-modified-version': String(this.itemVersion),
      };
      replay.put(`${prefix}/items?since=${v}`, { body: data, headers });
      for (let start = 0; start <= data.length; start += TICK_PAGE_SIZE) {
        replay.put(`${prefix}/items?since=${v}&limit=${TICK_PAGE_SIZE}&start=${start}`, {
          body: data.slice(start, start + TICK_PAGE_SIZE),
          headers,
        });
      }
    }

    for (let v = 0; v <= this.fulltextVersion; v++) {
      const census = this.fulltextCensusMap(v);
      replay.put(`${prefix}/fulltext?since=${v}`, {
        body: census,
        headers: { 'last-modified-version': String(this.fulltextVersion) },
      });
    }

    for (const key of this.items.keys()) {
      const ft = this.fulltext.get(key);
      replay.put(
        `${prefix}/items/${key}/fulltext`,
        ft
          ? { body: { content: ft.content, indexedPages: ft.indexedPages, totalPages: ft.totalPages } }
          : { status: 404, body: { error: 'no full text' } },
      );
      replay.put(`${prefix}/items/${key}/file`, { text: `bytes of ${key}` });
    }
  }

  // -------------------------------------------------- the fixture's own gate

  /**
   * Every property a test in this tranche is allowed to rely on. Run it before trusting
   * the fixture; `corrupt()` proves it can fail.
   */
  assertInvariants(): void {
    const tops = [...this.items.values()].filter((i) => !i.parentItem && i.itemType !== 'attachment');
    if (tops.length < 50) throw new Error(`synthetic library has ${tops.length} top-level items, want >= 50`);

    const dates = tops.map((i) => i.dateAdded);
    const sorted = [...dates].sort();
    if (dates.join() !== sorted.join()) throw new Error('top-level dateAdded is not in key order');
    if (new Set(dates).size !== dates.length) throw new Error('two top-level items share a dateAdded');

    for (const item of this.items.values()) {
      if (item.parentItem && !this.items.has(item.parentItem)) {
        throw new Error(`${item.key} is orphaned: no parent ${item.parentItem}`);
      }
    }
    if (![...this.items.values()].some((i) => i.itemType === 'note')) throw new Error('no child note');
    if (![...this.items.values()].some((i) => i.itemType === 'annotation')) throw new Error('no annotation');

    for (const key of this.fulltext.keys()) {
      const item = this.items.get(key);
      if (!item) throw new Error(`full-text census names ${key}, which is not an item`);
      if (item.itemType !== 'attachment') throw new Error(`full-text census names ${key}, not an attachment`);
    }

    const monster = this.fulltext.get(this.monsterAttachment);
    if (!monster) throw new Error('the monster attachment has no extracted text');
    const blocks = monster.content.split('\n\n').length;
    if (blocks < this.opts.monsterPassages) {
      throw new Error(`monster attachment has ${blocks} blocks, want >= ${this.opts.monsterPassages}`);
    }

    const snapshot = this.fulltext.get(this.emptySnapshot);
    if (!snapshot) throw new Error('the near-empty snapshot has no extracted text');
    if (snapshot.content.length > 200) throw new Error('the near-empty snapshot is not near-empty');

    if (![...this.fulltext.values()].some((f) => f.version === 0)) {
      throw new Error('no version-0 residue: the fixture cannot exercise §5.2.4');
    }
  }

  /**
   * Break one property on purpose. The positive control feeds each of these to
   * `assertInvariants()` and requires it to throw — a gate whose all-clear is
   * indistinguishable from "I could not look" is not a gate.
   */
  corrupt(kind: 'ordering' | 'orphan' | 'census' | 'residue' | 'monster'): void {
    switch (kind) {
      case 'ordering': {
        const a = this.items.get('ITEM0001');
        const b = this.items.get('ITEM0002');
        if (!a || !b) throw new Error('fixture is missing the items to reorder');
        const swap = a.dateAdded;
        a.dateAdded = b.dateAdded;
        b.dateAdded = swap;
        return;
      }
      case 'orphan': {
        const note = this.items.get('NOTE0001');
        if (!note) throw new Error('fixture is missing NOTE0001');
        note.parentItem = 'ITEMGONE';
        return;
      }
      case 'census':
        this.fulltext.set('NOSUCHKEY', { version: 9, content: 'x', indexedPages: 1, totalPages: 1 });
        return;
      case 'residue':
        for (const [key, ft] of this.fulltext) if (ft.version === 0) this.fulltext.set(key, { ...ft, version: 99 });
        return;
      case 'monster': {
        const monster = this.fulltext.get(this.monsterAttachment);
        if (!monster) throw new Error('fixture is missing the monster attachment');
        this.fulltext.set(this.monsterAttachment, { ...monster, content: 'one block only' });
        return;
      }
    }
  }
}

/** `n` passage-sized blocks of deterministic prose, separated by a blank line. */
function block(tag: string, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      `Block ${i} of ${tag}. ` +
        'The estimator is consistent under the stated moment conditions, and the residual ' +
        'variance falls monotonically with the sample size across every replication reported here.',
    );
  }
  return out.join('\n\n');
}

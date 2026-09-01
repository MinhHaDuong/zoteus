import { describe, it, expect } from 'vitest';
import { ReplayLocalApi } from '../fixtures/local-api-replay.js';
import { SyntheticLibrary } from '../fixtures/synthetic-library.js';
import { ManualClock } from '../fixtures/clock.js';

/**
 * The three fixtures of ticket 0551, and the positive control each one owes.
 *
 * A fixture is trusted by every test written after it, so it is the one piece of a suite
 * that nothing else checks. The discipline here is to break each one on purpose and
 * require the failure to show: a fixture whose "everything is fine" is indistinguishable
 * from "I could not look" is worth nothing, and its silence would read as evidence.
 */

describe('fixture (a): the record/replay local-API fake', () => {
  it('answers a real LocalApiClient with what it was given, and nothing else', async () => {
    const replay = new ReplayLocalApi();
    replay.put('/users/0/fulltext?since=0', { body: { ATTA0001: 7 } });
    const client = replay.client();

    expect(await client.fullTextSince(0)).toEqual({ ATTA0001: 7 });
    expect(replay.requests.map((r) => r.key)).toEqual(['GET /users/0/fulltext?since=0']);
  });

  it('positive control: the answer follows the cassette, not a default', async () => {
    // The control the previous test cannot give: an assertion that passes against a fake
    // answering a fixed thing would pass here too. Re-canning the same route with
    // different content must change the answer.
    const replay = new ReplayLocalApi();
    replay.put('/users/0/fulltext?since=0', { body: { ATTA0001: 7 } });
    expect(await replay.client().fullTextSince(0)).toEqual({ ATTA0001: 7 });

    replay.put('/users/0/fulltext?since=0', { body: { ATTA0002: 9 } });
    expect(await replay.client().fullTextSince(0)).toEqual({ ATTA0002: 9 });
  });

  it('positive control: an unregistered route is a loud failure, not an empty answer', async () => {
    const replay = new ReplayLocalApi();
    replay.put('/users/0/fulltext?since=0', { body: {} });
    // A typo'd route answering 404 would surface as "no full text" — a plausible,
    // wrong, silent negative. Strict mode makes the test author's mistake visible.
    await expect(replay.client().fullTextSince(99)).rejects.toThrow(/no canned response/);
  });

  it('normalises query order, so a cassette survives a caller reordering parameters', async () => {
    const replay = new ReplayLocalApi();
    replay.put('/users/0/items?format=versions&since=3', { body: { ITEM0001: 4 } });
    // LocalApiClient emits `since` first and `format` second.
    const result = await replay.client().itemVersions({ since: 3 });
    expect(result.versions).toEqual({ ITEM0001: 4 });
  });

  it('reads Total-Results and Last-Modified-Version off the canned headers', async () => {
    const replay = new ReplayLocalApi();
    replay.put('/users/0/items?format=versions', {
      body: { ITEM0001: 4, ITEM0002: 9 },
      headers: { 'total-results': '2', 'last-modified-version': '9' },
    });
    const result = await replay.client().itemVersions({});
    expect(result.totalResults).toBe(2);
    expect(result.lastModifiedVersion).toBe(9);
  });

  it('goes silent the way an absent desktop app does', async () => {
    const replay = new ReplayLocalApi();
    replay.put('/users/0/fulltext?since=0', { body: {} });
    replay.silent = true;
    await expect(replay.client().fullTextSince(0)).rejects.toThrow(/fetch failed/);
  });

  it('charges programmable latency to the injected clock instead of waiting it out', async () => {
    const clock = new ManualClock(1_000);
    const replay = new ReplayLocalApi({ clock });
    replay.put('/users/0/fulltext?since=0', { body: {} });
    replay.latencyMs = 4_000;

    await replay.client().fullTextSince(0);
    // The observation the tranche-3 back-off will read, at no wall-clock cost.
    expect(clock.now()).toBe(5_000);
    expect(replay.requests[0]?.at).toBe(5_000);
  });

  it('round-trips a cassette', async () => {
    const source = new ReplayLocalApi();
    source.put('/users/0/fulltext?since=0', { body: { ATTA0001: 7 } });
    const replayed = new ReplayLocalApi().load(source.cassette());
    expect(await replayed.client().fullTextSince(0)).toEqual({ ATTA0001: 7 });
  });
});

describe('fixture (b): the synthetic library', () => {
  it('holds the shape the later tranches test against', () => {
    const library = new SyntheticLibrary();
    library.assertInvariants();

    expect(library.keys().filter((k) => k.startsWith('ITEM')).length).toBe(50);
    expect(library.fulltextFor(library.monsterAttachment)?.content.split('\n\n').length).toBe(500);
    expect(library.fulltextFor(library.emptySnapshot)?.content.length).toBeLessThan(200);
    // The two sequences are independent, which is the property the tick exists for.
    expect(library.fulltextVersion).toBeLessThan(library.itemVersion);
  });

  it('moves one sequence at a time, as Zotero does', () => {
    const library = new SyntheticLibrary();
    const beforeItems = library.itemVersion;
    const beforeText = library.fulltextVersion;

    library.touch('ITEM0003');
    expect(library.itemVersion).toBe(beforeItems + 1);
    expect(library.fulltextVersion).toBe(beforeText);

    library.extract('ATTA0025', 'freshly opened');
    expect(library.itemVersion).toBe(beforeItems + 1);
    expect(library.fulltextVersion).toBe(beforeText + 1);
  });

  it.each(['ordering', 'orphan', 'census', 'residue', 'monster'] as const)(
    'positive control: assertInvariants catches a broken %s',
    (kind) => {
      const library = new SyntheticLibrary();
      library.assertInvariants();
      library.corrupt(kind);
      expect(() => library.assertInvariants()).toThrow();
    },
  );

  it('serves itself over the replay fake, at every watermark a resume could hold', async () => {
    const library = new SyntheticLibrary();
    const replay = new ReplayLocalApi();
    library.install(replay);
    const client = replay.client();

    const full = await client.itemVersions({});
    expect(Object.keys(full.versions).length).toBe(library.keys().length);
    expect(full.lastModifiedVersion).toBe(library.itemVersion);

    // Any watermark between 0 and the head resolves, so a resume is not a strict-mode
    // throw a reader would have to interpret.
    const mid = Math.floor(library.itemVersion / 2);
    const delta = await client.itemVersions({ since: mid });
    expect(Object.keys(delta.versions).length).toBeLessThan(Object.keys(full.versions).length);
    expect(Object.values(delta.versions).every((v) => v > mid)).toBe(true);
  });

  it('serves the /file route the extract stage will need', async () => {
    const library = new SyntheticLibrary();
    const replay = new ReplayLocalApi();
    library.install(replay);
    const bytes = await replay.client().downloadFileBytes(library.monsterAttachment);
    expect(new TextDecoder().decode(bytes)).toBe(`bytes of ${library.monsterAttachment}`);
  });
});

describe('fixture (c): the injected clock', () => {
  it('moves only when a test moves it', () => {
    const clock = new ManualClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(60_000);
    expect(clock.now()).toBe(61_000);
  });

  it('positive control: refuses to run backwards', () => {
    const clock = new ManualClock(1_000);
    expect(() => clock.advance(-1)).toThrow(/backwards/);
    expect(() => clock.set(999)).toThrow(/backwards/);
    expect(clock.now()).toBe(1_000);
  });
});

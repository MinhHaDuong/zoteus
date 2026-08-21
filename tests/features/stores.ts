import { MemoryPassageStore, type PassageStore } from '../../src/features/search/passage-store.js';
import { Fts5PassageStore } from '../../src/features/search/fts5-store.js';

/**
 * The two passage backends, for `describe.each`. The point of parameterising upstream's
 * own suites rather than writing parallel copies is that the FTS5 store is held to the
 * assertions that already define what search means here — not to a friendlier set.
 */
export const STORES: Array<[string, () => PassageStore]> = [
  ['memory', () => new MemoryPassageStore()],
  ['fts5', () => new Fts5PassageStore(':memory:')],
];

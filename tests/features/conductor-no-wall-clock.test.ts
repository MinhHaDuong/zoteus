import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "No wall-clock sleep anywhere" is ticket 0551's own verification line, and a line in a
 * ticket is not a gate. This is the gate.
 *
 * It reads the conductor's source, its tests and the shared fixtures, and fails on a real
 * timer or a direct read of wall time. Both matter for the same reason: the conductor's
 * cadences are the thing under test, and a suite that waits for one cannot say whether it
 * fired on time or merely fired. A timer also makes the suite's cost the design's cost —
 * one 60 s tick would put a minute in every run, so the run stops happening.
 *
 * Directories rather than a file list, deliberately. A hand-written list guards removal
 * and not arrival: the file that slips through is the one added next month, and a gate
 * that cannot see it reports "all clear" exactly as it would report "I could not look".
 *
 * A line that genuinely needs wall time — the system clock's own definition — says so
 * with a marker. That is what keeps the rule honest rather than absolute.
 */

const ROOT = new URL('../..', import.meta.url).pathname;
const MARKER = 'wall-clock: intentional';
// The three marked lines below are this file naming what it forbids. Marked rather than
// excluded: excluding a file from its own scan is the one exemption that would also hide
// a real timer added to it later.
const FORBIDDEN = /\b(setTimeout|setInterval|setImmediate|Date\.now)\b/; // wall-clock: intentional

function scan(dir: string, filter: (name: string) => boolean): string[] {
  return readdirSync(join(ROOT, dir))
    .filter(filter)
    .map((name) => join(dir, name));
}

function offendingLines(relative: string): string[] {
  return offendingLinesOf(readFileSync(join(ROOT, relative), 'utf8'), relative);
}

function offendingLinesOf(source: string, relative = '<inline>'): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => FORBIDDEN.test(line) && !line.includes(MARKER) && !isComment(line))
    .map(({ line, n }) => `${relative}:${n}: ${line.trim()}`);
}

/** A rule about what the code does should not fire on a sentence describing the rule. */
function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('the conductor tranche holds no wall clock', () => {
  const files = [
    ...scan('src/features/search/conductor', (n) => n.endsWith('.ts')),
    ...scan('tests/features', (n) => n.startsWith('conductor-') && n.endsWith('.ts')),
    ...scan('tests/fixtures', (n) => n.endsWith('.ts')),
  ];

  it('covers every file in the tranche, so an arrival cannot slip past', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files).toContain('src/features/search/conductor/reconcile-tick.ts');
    expect(files).toContain('tests/fixtures/clock.ts');
  });

  it.each(files)('%s calls no timer and reads no wall time', (relative) => {
    expect(offendingLines(relative)).toEqual([]);
  });

  it('positive control: the detector fires on the thing it is looking for', () => {
    // Without this the suite above proves only that the regex found nothing, which is
    // also what a broken regex, a wrong path and an empty file list all report.
    for (const bad of ['await new Promise((r) => setTimeout(r, 50));', 'const t = Date.now();']) { // wall-clock: intentional
      expect(offendingLinesOf(bad)).toHaveLength(1);
    }
    // And it lets through the one line that has to read wall time.
    const exempt = `export const systemClock = { now: () => Date.now() }; // ${MARKER}`; // wall-clock: intentional
    expect(offendingLinesOf(exempt)).toEqual([]);
  });
});

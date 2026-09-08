/**
 * The declared Node floor, and the one dependency that can outrun it silently (#69).
 *
 * `pdfjs-dist` runs on Node 20.19 only up to 5.6.205: every release after it (5.7.284 and
 * the whole 6.x line) declares `>=22.13.0 || >=24`. Under a caret range any resolve that
 * ignores the lockfile (`npm update`, a deleted lockfile, a downstream project resolving
 * `@oscardvs/zoteus` into its own tree) would take one of those and quietly break the Node
 * 20 promise the CI matrix exists to defend, with nothing failing until the runtime did.
 * So the optional dependency is pinned exactly, and these tests fail the moment the pin,
 * the lockfile, or the places that declare the floor stop agreeing with each other.
 *
 * Everything here is read off the repo's own files: no network, no install, no node_modules.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (...parts: string[]): string => readFileSync(join(repo, ...parts), 'utf8');
const readJson = <T>(...parts: string[]): T => JSON.parse(read(...parts)) as T;

interface PackageJson {
  engines?: { node?: string };
  optionalDependencies?: Record<string, string>;
}

interface LockEntry {
  version?: string;
  engines?: { node?: string };
  optionalDependencies?: Record<string, string>;
}

interface Lockfile {
  packages?: Record<string, LockEntry>;
}

interface Manifest {
  compatibility?: { runtimes?: { node?: string } };
}

type Version = [number, number, number];

/** `major.minor.patch` of a bare version string, zero-filling the parts it leaves out. */
function parseVersion(v: string): Version {
  const parts = v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Negative when a sorts below b, zero when they are the same version. */
function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Lowest Node version an `engines.node` range admits. Every range in play is a union of
 * `>=x`, `^x` or bare clauses (`>=20.19.0 || >=22.13.0 || >=24`), so the union's floor is
 * the lowest clause floor. An unrecognised clause throws rather than being guessed at: a
 * test that silently mis-reads the range it is guarding would be worse than no test.
 */
function floorOf(range: string): Version {
  const floors = range.split('||').map((clause) => {
    const m = /^\s*(?:>=|\^|~)?\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(clause);
    if (!m) throw new Error(`unsupported engines clause "${clause.trim()}" in "${range}"`);
    return parseVersion(m[1]!);
  });
  return floors.sort(compare)[0]!;
}

describe('the declared Node floor', () => {
  const pkg = readJson<PackageJson>('package.json');
  const lock = readJson<Lockfile>('package-lock.json');
  const manifest = readJson<Manifest>('mcpb', 'manifest.json');
  const pdfjs = lock.packages?.['node_modules/pdfjs-dist'];

  it('is declared in package.json', () => {
    expect(pkg.engines?.node).toBeTruthy();
  });

  it('pins pdfjs-dist exactly, so a lockfile-free resolve cannot cross it (#69)', () => {
    const range = pkg.optionalDependencies?.['pdfjs-dist'];
    // A caret admits 5.7.284, which needs Node 22.13. Only an exact version holds the line.
    expect(range).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pdfjs?.version).toBe(range);
    expect(lock.packages?.['']?.optionalDependencies?.['pdfjs-dist']).toBe(range);
  });

  it('admits the pdfjs-dist the lockfile resolves', () => {
    const engines = pdfjs?.engines?.node;
    expect(engines).toBeTruthy();
    const floor = floorOf(pkg.engines!.node!);
    // Fails the day the lockfile carries a pdfjs-dist wanting a newer Node than we promise.
    expect(
      compare(floorOf(engines!), floor),
      `pdfjs-dist ${pdfjs?.version} needs "${engines}", but package.json promises "${pkg.engines?.node}"`,
    ).toBeLessThanOrEqual(0);
  });

  it('is the same in package.json, the lockfile and mcpb/manifest.json', () => {
    const floor = floorOf(pkg.engines!.node!);
    expect(floorOf(lock.packages?.['']?.engines?.node ?? '')).toEqual(floor);
    expect(floorOf(manifest.compatibility?.runtimes?.node ?? '')).toEqual(floor);
  });

  it('is the lowest Node major the CI matrix builds on', () => {
    const m = /node-version:\s*\[([^\]]+)\]/.exec(read('.github', 'workflows', 'ci.yml'));
    expect(m).toBeTruthy();
    const majors = m![1]!.split(',').map((n) => Number.parseInt(n.trim(), 10));
    expect(majors.every(Number.isInteger)).toBe(true);
    expect(Math.min(...majors)).toBe(floorOf(pkg.engines!.node!)[0]);
  });
});

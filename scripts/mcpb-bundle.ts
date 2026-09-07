/**
 * Stage, pack and verify the Claude Desktop bundles (.mcpb), one per operating system.
 *
 *   npx tsx scripts/mcpb-bundle.ts build <platform>              # darwin | win32 | linux
 *   npx tsx scripts/mcpb-bundle.ts stage <dir> <platform>        # the tree `build` packs
 *   npx tsx scripts/mcpb-bundle.ts check <archive.mcpb> [platform]
 *
 * Why one bundle per OS (issue #62). pdfjs-dist, which gives zotero_fulltext its exact page
 * numbers, draws through @napi-rs/canvas, and that package's skia binary is a separate npm
 * package per OS and CPU which npm installs only for the machine it runs on. The release job
 * runs `npm ci` on a Linux runner, so the single zoteus.mcpb it packed up to v1.15.0 carried
 * the two linux-x64 binaries while its manifest promised darwin and win32 as well; there,
 * importing pdfjs failed (`DOMMatrix is not defined`) and page extraction quietly fell back to
 * approximate pages. Carrying every binary in one file triples it (103 MB measured against 34),
 * and the manifest's compatibility.platforms knows operating systems, not CPUs, so a bundle per
 * OS is the smallest unit whose label can be exact: each carries the binaries for both CPUs of
 * its OS (32 to 57 MB) and names only that OS.
 *
 * Nothing here hardcodes a package version. `npm ci --os --cpu` and `npm install --no-save --os
 * --cpu` resolve the platform packages from package-lock.json (npm 10.3 or newer), and `check`
 * derives the binaries an archive must carry from the same lockfile, so a canvas upgrade that
 * adds a target is picked up, and one that drops a target fails the release instead of shipping
 * a bundle that does not do what its manifest says. `check` also accepts a downloaded release
 * asset, which is how the v1.15.0 gap was found in the first place.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Platform = 'darwin' | 'win32' | 'linux';

/**
 * What each bundle is called and which CPUs it carries a binary for: the ones Node itself
 * ships for on that OS. The asset names say "macos" and "windows" because the people
 * downloading them are researchers, not Node developers.
 */
export const BUNDLES: Record<Platform, { asset: string; cpus: readonly string[] }> = {
  darwin: { asset: 'zoteus-macos.mcpb', cpus: ['arm64', 'x64'] },
  win32: { asset: 'zoteus-windows.mcpb', cpus: ['x64', 'arm64'] },
  linux: { asset: 'zoteus-linux.mcpb', cpus: ['x64', 'arm64'] },
};
export const PLATFORMS = Object.keys(BUNDLES) as Platform[];

export interface LockfilePackage {
  version?: string;
  os?: string[];
  cpu?: string[];
  dev?: boolean;
  optional?: boolean;
}
export interface Lockfile {
  packages?: Record<string, LockfilePackage>;
}
export interface Manifest {
  compatibility?: { platforms?: string[] } & Record<string, unknown>;
  [key: string]: unknown;
}

/** A platform-specific canvas package as the lockfile records it. */
export interface NativePackage {
  name: string;
  version: string;
  /** Its directory inside the bundle, e.g. `node_modules/@napi-rs/canvas-darwin-arm64`. */
  dir: string;
}

const NATIVE_MARKER = 'node_modules/@napi-rs/canvas-';

/** Files every bundle must contain, whatever its OS, and what each one proves. */
const ALWAYS_REQUIRED: ReadonlyArray<{ entry: string; proves: string }> = [
  { entry: 'manifest.json', proves: 'the manifest' },
  { entry: 'icon.png', proves: 'the icon' },
  { entry: 'dist/index.js', proves: 'the server entry point' },
  { entry: 'node_modules/@modelcontextprotocol/sdk/package.json', proves: 'the MCP SDK' },
  { entry: 'node_modules/pdfjs-dist/legacy/build/pdf.mjs', proves: 'pdfjs-dist' },
  { entry: 'node_modules/@napi-rs/canvas/js-binding.js', proves: 'the canvas loader' },
];

/**
 * The @napi-rs/canvas binaries the lockfile holds for `platform` on the CPUs its bundle
 * carries. Read from the lockfile so the versions are never repeated here; sorted so the
 * output and the tests are stable.
 */
export function requiredNativePackages(lock: Lockfile, platform: Platform): NativePackage[] {
  const cpus = BUNDLES[platform].cpus;
  const out: NativePackage[] = [];
  for (const [dir, pkg] of Object.entries(lock.packages ?? {})) {
    const at = dir.lastIndexOf(NATIVE_MARKER);
    if (at < 0 || pkg.dev) continue;
    if (!pkg.os?.includes(platform) || !pkg.cpu?.some((cpu) => cpus.includes(cpu))) continue;
    out.push({ name: dir.slice(at + 'node_modules/'.length), version: pkg.version ?? '', dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The template manifest with `compatibility.platforms` narrowed to the one OS this bundle is for. */
export function platformManifest(template: Manifest, platform: Platform): Manifest {
  return {
    ...template,
    compatibility: { ...(template.compatibility ?? {}), platforms: [platform] },
  };
}

/** The OS a canvas binary's directory is built for, from `@napi-rs/canvas-<os>-<cpu>...`. */
function nativeEntryOs(entry: string): string | undefined {
  const at = entry.lastIndexOf(NATIVE_MARKER);
  if (at < 0) return undefined;
  return entry.slice(at + NATIVE_MARKER.length).split(/[-/]/, 1)[0];
}

export interface Audit {
  /** Everything wrong; empty means the archive is what its label says. */
  problems: string[];
  /** Each required binary that was found, with the archive entry that proves it. */
  binaries: Array<NativePackage & { entry: string }>;
}

/**
 * Everything wrong with an archive's listing for a bundle labelled `platform`: the manifest
 * must name exactly that OS; the entry point, the SDK, pdfjs and the canvas loader must be
 * present; every native package the lockfile holds for the OS's CPUs must contribute a
 * `.node` file (a package directory with only a package.json is the failure npm's optional
 * dependency handling produces, so the binary itself is what is checked); and no canvas
 * binary for another OS may ride along, since the label would not cover it and it would
 * cost the download 10 MB or more.
 */
export function auditBundle(opts: {
  platform: Platform;
  manifest: Manifest;
  entries: string[];
  lock: Lockfile;
}): Audit {
  const { platform, manifest, entries, lock } = opts;
  const problems: string[] = [];
  const binaries: Audit['binaries'] = [];
  const have = new Set(entries);

  const advertised = manifest.compatibility?.platforms ?? [];
  if (advertised.length !== 1 || advertised[0] !== platform) {
    problems.push(
      `manifest advertises [${advertised.join(', ')}] but this bundle is built for ${platform} only`,
    );
  }
  for (const { entry, proves } of ALWAYS_REQUIRED) {
    if (!have.has(entry)) problems.push(`missing ${entry} (${proves})`);
  }
  const required = requiredNativePackages(lock, platform);
  if (required.length === 0) {
    problems.push(`the lockfile holds no @napi-rs/canvas binary for ${platform}`);
  }
  for (const pkg of required) {
    const entry = entries.find((e) => e.startsWith(`${pkg.dir}/`) && e.endsWith('.node'));
    if (entry) binaries.push({ ...pkg, entry });
    else problems.push(`${pkg.name}@${pkg.version} has no .node binary in the archive`);
  }
  const foreign = new Set<string>();
  for (const entry of entries) {
    const os = nativeEntryOs(entry);
    if (os && os !== platform)
      foreign.add(
        entry.slice(0, entry.indexOf('/', entry.lastIndexOf(NATIVE_MARKER) + NATIVE_MARKER.length)),
      );
  }
  for (const dir of [...foreign].sort()) {
    problems.push(`${dir} is for another OS and does not belong in the ${platform} bundle`);
  }
  return { problems, binaries };
}

// ---------------------------------------------------------------------------------------------
// The commands. Everything above is pure and unit-tested; everything below touches the disk,
// npm and the mcpb CLI, and is exercised by the release job.

const INSTALL_FLAGS = ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function fail(message: string): never {
  // The `::error::` prefix becomes an annotation in GitHub Actions and is harmless elsewhere.
  console.error(`::error::${message}`);
  process.exit(1);
}

function asPlatform(value: string | undefined): Platform {
  if (value && (PLATFORMS as string[]).includes(value)) return value as Platform;
  return fail(
    `platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(value ?? '')}`,
  );
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** `--os` and `--cpu` are what let a Linux runner install another platform's optional deps. */
function assertNpmCanTargetOtherPlatforms(): void {
  const version = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major < 10 || (major === 10 && minor < 3)) {
    fail(
      `npm ${version} cannot install another platform's optional dependencies; ` +
        `--os, --cpu and --libc need npm 10.3 or newer (Node 22 ships 10.5 or later)`,
    );
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Build the complete tree one bundle is packed from: narrowed manifest, icon, dist, and the
 * production dependencies with the canvas binary for every CPU of `platform`. The first CPU
 * comes from `npm ci` with the platform overridden, which also keeps the host's own binaries
 * out; each further CPU is added with `npm install --no-save` under the same overrides, which
 * keeps what is already there (verified: the lockfile is left byte-identical).
 */
export function stage(dir: string, platform: Platform): void {
  assertNpmCanTargetOtherPlatforms();
  const root = repoRoot();
  if (!existsSync(join(root, 'dist', 'index.js')))
    fail('dist/index.js is missing: run `npm run build` first');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const template = readJson<Manifest>(join(root, 'mcpb', 'manifest.json'));
  writeFileSync(
    join(dir, 'manifest.json'),
    `${JSON.stringify(platformManifest(template, platform), null, 2)}\n`,
  );
  copyFileSync(join(root, 'mcpb', 'icon.png'), join(dir, 'icon.png'));
  cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json'])
    copyFileSync(join(root, file), join(dir, file));

  const [first, ...rest] = BUNDLES[platform].cpus;
  run('npm', ['ci', ...INSTALL_FLAGS, `--os=${platform}`, `--cpu=${first}`], dir);
  for (const cpu of rest) {
    run('npm', ['install', '--no-save', ...INSTALL_FLAGS, `--os=${platform}`, `--cpu=${cpu}`], dir);
  }

  // Look before packing, so a binary that did not land names the install at fault rather
  // than surfacing as a bad archive later.
  const lock = readJson<Lockfile>(join(root, 'package-lock.json'));
  for (const pkg of requiredNativePackages(lock, platform)) {
    const dirPath = join(dir, pkg.dir);
    const landed = existsSync(dirPath) && readdirSync(dirPath).some((f) => f.endsWith('.node'));
    if (!landed) fail(`${pkg.name}@${pkg.version} did not land in ${dir}`);
    console.log(`staged ${pkg.name}@${pkg.version}`);
  }
}

/** Stage, validate and pack one bundle into the repo root under its asset name. */
export function build(platform: Platform): string {
  const root = repoRoot();
  const dir = join(root, 'mcpb-build', platform);
  const archive = join(root, BUNDLES[platform].asset);
  stage(dir, platform);
  run('npx', ['--yes', '@anthropic-ai/mcpb', 'validate', join(dir, 'manifest.json')], root);
  run('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', dir, archive], root);
  console.log(`packed ${BUNDLES[platform].asset}: ${mb(statSync(archive).size)}`);
  return archive;
}

/**
 * The release gate: list the archive and refuse it unless it is exactly what its manifest
 * says. With no platform given, the manifest's single advertised OS is used, which is the
 * form for checking an asset downloaded from a release.
 */
export function check(archive: string, platform?: Platform): void {
  if (!existsSync(archive)) fail(`${archive} does not exist`);
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }),
  ) as Manifest;
  const advertised = manifest.compatibility?.platforms ?? [];
  const target = platform ?? (advertised.length === 1 ? asPlatform(advertised[0]) : undefined);
  if (!target) {
    fail(`${archive} advertises [${advertised.join(', ')}]; say which platform to check it as`);
  }
  const lock = readJson<Lockfile>(join(repoRoot(), 'package-lock.json'));
  const { problems, binaries } = auditBundle({ platform: target, manifest, entries, lock });
  console.log(
    `${archive}: ${mb(statSync(archive).size)}, ${entries.length} files, manifest platforms [${advertised.join(', ')}]`,
  );
  for (const b of binaries) console.log(`  ok  ${b.name}@${b.version}  ${b.entry}`);
  if (problems.length) {
    for (const p of problems) console.error(`::error::${archive}: ${p}`);
    process.exit(1);
  }
  console.log(
    `${archive}: carries the native PDF dependency for every ${target} CPU (${binaries.length} binaries)`,
  );
}

function main(argv: string[]): void {
  const [command, a, b] = argv;
  switch (command) {
    case 'build':
      build(asPlatform(a));
      return;
    case 'stage':
      if (!a) fail('usage: stage <dir> <platform>');
      stage(resolve(a), asPlatform(b));
      return;
    case 'check':
      if (!a) fail('usage: check <archive.mcpb> [platform]');
      check(resolve(a), b === undefined ? undefined : asPlatform(b));
      return;
    default:
      fail(
        'usage: mcpb-bundle.ts build <platform> | stage <dir> <platform> | check <archive> [platform]',
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}

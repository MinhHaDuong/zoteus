/**
 * The per-platform Claude Desktop bundles (issue #62).
 *
 * pdfjs-dist's native canvas binary is a separate npm package per OS and CPU, and npm installs
 * only the host's, so the v1.15.0 zoteus.mcpb packed on a Linux runner carried linux-x64
 * binaries under a manifest promising darwin and win32. These tests pin the pure half of
 * scripts/mcpb-bundle.ts: which binaries the lockfile owes each platform, how the manifest is
 * narrowed, and what the release gate must refuse. The script's disk, npm and mcpb-CLI half is
 * exercised by the release job itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUNDLES,
  PLATFORMS,
  auditBundle,
  platformManifest,
  requiredNativePackages,
  type Lockfile,
  type Manifest,
  type Platform,
} from '../../scripts/mcpb-bundle.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The @napi-rs/canvas family as the real lockfile records it, plus a dev package that is also
 *  OS-gated (esbuild's) to prove only canvas is counted. */
const lock: Lockfile = {
  packages: {
    'node_modules/@napi-rs/canvas': { version: '0.1.100', optional: true },
    'node_modules/@napi-rs/canvas-android-arm64': {
      version: '0.1.100',
      os: ['android'],
      cpu: ['arm64'],
    },
    'node_modules/@napi-rs/canvas-darwin-arm64': {
      version: '0.1.100',
      os: ['darwin'],
      cpu: ['arm64'],
    },
    'node_modules/@napi-rs/canvas-darwin-x64': { version: '0.1.100', os: ['darwin'], cpu: ['x64'] },
    'node_modules/@napi-rs/canvas-linux-arm-gnueabihf': {
      version: '0.1.100',
      os: ['linux'],
      cpu: ['arm'],
    },
    'node_modules/@napi-rs/canvas-linux-arm64-gnu': {
      version: '0.1.100',
      os: ['linux'],
      cpu: ['arm64'],
    },
    'node_modules/@napi-rs/canvas-linux-arm64-musl': {
      version: '0.1.100',
      os: ['linux'],
      cpu: ['arm64'],
    },
    'node_modules/@napi-rs/canvas-linux-riscv64-gnu': {
      version: '0.1.100',
      os: ['linux'],
      cpu: ['riscv64'],
    },
    'node_modules/@napi-rs/canvas-linux-x64-gnu': {
      version: '0.1.100',
      os: ['linux'],
      cpu: ['x64'],
    },
    'node_modules/@napi-rs/canvas-linux-x64-musl': {
      version: '0.1.100',
      os: ['linux'],
      cpu: ['x64'],
    },
    'node_modules/@napi-rs/canvas-win32-arm64-msvc': {
      version: '0.1.100',
      os: ['win32'],
      cpu: ['arm64'],
    },
    'node_modules/@napi-rs/canvas-win32-x64-msvc': {
      version: '0.1.100',
      os: ['win32'],
      cpu: ['x64'],
    },
    'node_modules/@esbuild/darwin-arm64': {
      version: '0.28.0',
      os: ['darwin'],
      cpu: ['arm64'],
      dev: true,
    },
  },
};

const template: Manifest = {
  name: 'zoteus',
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.19.0' } },
};

/** Everything a bundle needs besides its binaries. */
const skeleton = [
  'manifest.json',
  'icon.png',
  'dist/index.js',
  'node_modules/@modelcontextprotocol/sdk/package.json',
  'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'node_modules/@napi-rs/canvas/js-binding.js',
  'node_modules/@napi-rs/canvas/index.js',
];

/** The archive entries a canvas platform package contributes, as npm lays it out. */
const binary = (suffix: string): string[] => [
  `node_modules/@napi-rs/canvas-${suffix}/package.json`,
  `node_modules/@napi-rs/canvas-${suffix}/README.md`,
  `node_modules/@napi-rs/canvas-${suffix}/skia.${suffix}.node`,
];

/** What the published v1.15.0 zoteus.mcpb contained: the Linux runner's own two binaries. */
const v1150Entries = [...skeleton, ...binary('linux-x64-gnu'), ...binary('linux-x64-musl')];

describe('requiredNativePackages', () => {
  it('owes darwin both Apple CPUs and nothing else', () => {
    expect(requiredNativePackages(lock, 'darwin').map((p) => `${p.name}@${p.version}`)).toEqual([
      '@napi-rs/canvas-darwin-arm64@0.1.100',
      '@napi-rs/canvas-darwin-x64@0.1.100',
    ]);
  });

  it('owes win32 the x64 and arm64 MSVC builds', () => {
    expect(requiredNativePackages(lock, 'win32').map((p) => p.name)).toEqual([
      '@napi-rs/canvas-win32-arm64-msvc',
      '@napi-rs/canvas-win32-x64-msvc',
    ]);
  });

  it('owes linux glibc and musl for x64 and arm64, but not 32-bit arm or riscv64', () => {
    expect(requiredNativePackages(lock, 'linux').map((p) => p.name)).toEqual([
      '@napi-rs/canvas-linux-arm64-gnu',
      '@napi-rs/canvas-linux-arm64-musl',
      '@napi-rs/canvas-linux-x64-gnu',
      '@napi-rs/canvas-linux-x64-musl',
    ]);
  });

  it('reports the directory the binary must sit in inside the bundle', () => {
    expect(requiredNativePackages(lock, 'darwin')[0].dir).toBe(
      'node_modules/@napi-rs/canvas-darwin-arm64',
    );
  });

  it('finds a canvas package nested under another package', () => {
    const nested: Lockfile = {
      packages: {
        'node_modules/pdfjs-dist/node_modules/@napi-rs/canvas-darwin-arm64': {
          version: '0.1.101',
          os: ['darwin'],
          cpu: ['arm64'],
        },
      },
    };
    expect(requiredNativePackages(nested, 'darwin')).toEqual([
      {
        name: '@napi-rs/canvas-darwin-arm64',
        version: '0.1.101',
        dir: 'node_modules/pdfjs-dist/node_modules/@napi-rs/canvas-darwin-arm64',
      },
    ]);
  });

  it('the repo lockfile holds a binary for every CPU of every advertised platform, at one version', () => {
    const real = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')) as Lockfile;
    const canvas = real.packages?.['node_modules/@napi-rs/canvas']?.version;
    expect(canvas).toBeTruthy();
    for (const platform of PLATFORMS) {
      const owed = requiredNativePackages(real, platform);
      // Every CPU the bundle promises has at least one package (linux has two per CPU).
      for (const cpu of BUNDLES[platform].cpus) {
        expect(owed.some((p) => p.name.includes(`-${cpu}-`) || p.name.endsWith(`-${cpu}`))).toBe(
          true,
        );
      }
      for (const p of owed) expect(p.version).toBe(canvas);
    }
  });
});

describe('platformManifest', () => {
  it('narrows compatibility.platforms to the one OS and keeps everything else', () => {
    const out = platformManifest(template, 'win32');
    expect(out.compatibility?.platforms).toEqual(['win32']);
    expect(out.compatibility?.runtimes).toEqual({ node: '>=20.19.0' });
    expect(out.name).toBe('zoteus');
  });

  it('does not mutate the template', () => {
    platformManifest(template, 'linux');
    expect(template.compatibility?.platforms).toEqual(['darwin', 'win32', 'linux']);
  });

  it('the bundles cover exactly the platforms mcpb/manifest.json advertises', () => {
    const real = JSON.parse(readFileSync(join(repo, 'mcpb', 'manifest.json'), 'utf8')) as Manifest;
    expect([...(real.compatibility?.platforms ?? [])].sort()).toEqual([...PLATFORMS].sort());
  });
});

describe('auditBundle', () => {
  it('flags the v1.15.0 layout: linux binaries under a manifest promising darwin and win32 (#62)', () => {
    const { problems, binaries } = auditBundle({
      platform: 'darwin',
      manifest: template,
      entries: v1150Entries,
      lock,
    });
    expect(binaries).toEqual([]);
    expect(problems).toEqual([
      'manifest advertises [darwin, win32, linux] but this bundle is built for darwin only',
      '@napi-rs/canvas-darwin-arm64@0.1.100 has no .node binary in the archive',
      '@napi-rs/canvas-darwin-x64@0.1.100 has no .node binary in the archive',
      'node_modules/@napi-rs/canvas-linux-x64-gnu is for another OS and does not belong in the darwin bundle',
      'node_modules/@napi-rs/canvas-linux-x64-musl is for another OS and does not belong in the darwin bundle',
    ]);
  });

  const complete: Record<Platform, string[]> = {
    darwin: [...skeleton, ...binary('darwin-arm64'), ...binary('darwin-x64')],
    win32: [...skeleton, ...binary('win32-x64-msvc'), ...binary('win32-arm64-msvc')],
    linux: [
      ...skeleton,
      ...binary('linux-x64-gnu'),
      ...binary('linux-x64-musl'),
      ...binary('linux-arm64-gnu'),
      ...binary('linux-arm64-musl'),
    ],
  };

  for (const platform of PLATFORMS) {
    it(`accepts a ${platform} bundle that carries every CPU's binary under a ${platform}-only manifest`, () => {
      const { problems, binaries } = auditBundle({
        platform,
        manifest: platformManifest(template, platform),
        entries: complete[platform],
        lock,
      });
      expect(problems).toEqual([]);
      expect(binaries.map((b) => b.entry)).toEqual(
        requiredNativePackages(lock, platform).map(
          (p) => `${p.dir}/skia.${p.name.slice('@napi-rs/canvas-'.length)}.node`,
        ),
      );
    });
  }

  it('refuses a platform package that landed without its binary', () => {
    // npm's optional-dependency failure mode: the directory exists, the .node file does not.
    const entries = [
      ...skeleton,
      ...binary('darwin-arm64'),
      'node_modules/@napi-rs/canvas-darwin-x64/package.json',
    ];
    const { problems } = auditBundle({
      platform: 'darwin',
      manifest: platformManifest(template, 'darwin'),
      entries,
      lock,
    });
    expect(problems).toEqual([
      '@napi-rs/canvas-darwin-x64@0.1.100 has no .node binary in the archive',
    ]);
  });

  it('refuses a bundle missing the entry point, pdfjs or the canvas loader', () => {
    const entries = complete.win32.filter(
      (e) =>
        e !== 'dist/index.js' &&
        e !== 'node_modules/pdfjs-dist/legacy/build/pdf.mjs' &&
        e !== 'node_modules/@napi-rs/canvas/js-binding.js',
    );
    const { problems } = auditBundle({
      platform: 'win32',
      manifest: platformManifest(template, 'win32'),
      entries,
      lock,
    });
    expect(problems).toEqual([
      'missing dist/index.js (the server entry point)',
      'missing node_modules/pdfjs-dist/legacy/build/pdf.mjs (pdfjs-dist)',
      'missing node_modules/@napi-rs/canvas/js-binding.js (the canvas loader)',
    ]);
  });

  it('refuses a lockfile that has dropped every binary for the platform', () => {
    const { problems } = auditBundle({
      platform: 'linux',
      manifest: platformManifest(template, 'linux'),
      entries: complete.linux,
      lock: { packages: { 'node_modules/@napi-rs/canvas': { version: '0.1.100' } } },
    });
    expect(problems[0]).toBe('the lockfile holds no @napi-rs/canvas binary for linux');
  });

  it('every bundle has a distinct .mcpb asset name', () => {
    const names = PLATFORMS.map((p) => BUNDLES[p].asset);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^zoteus-[a-z]+\.mcpb$/);
  });
});

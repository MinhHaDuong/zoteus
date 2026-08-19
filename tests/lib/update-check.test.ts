import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateChecker, isNewerVersion } from '../../src/lib/update-check.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function ghResponse(tag: string) {
  return new Response(
    JSON.stringify({ tag_name: tag, html_url: `https://github.com/oscardvs/zoteus/releases/tag/${tag}` }),
    { status: 200 },
  );
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'zoteus-update-'));
}

describe('isNewerVersion', () => {
  it('compares dotted numeric versions', () => {
    expect(isNewerVersion('1.4.0', '1.3.1')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.3.1', '1.3.1')).toBe(false);
    expect(isNewerVersion('1.3.0', '1.3.1')).toBe(false);
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('1.4', '1.3.9')).toBe(true);
  });

  it('never treats a non-numeric version as newer', () => {
    expect(isNewerVersion('abc', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.4.0-beta.1', '1.3.1')).toBe(false);
  });
});

describe('UpdateChecker', () => {
  it('reports a newer release and caches the result', async () => {
    const dataDir = await tempDir();
    const fetchImpl = vi.fn(async () => ghResponse('v9.9.9'));
    const checker = new UpdateChecker({
      currentVersion: '1.3.1',
      dataDir,
      logger: silentLogger,
      enabled: true,
      fetchImpl,
    });
    await checker.start();
    expect(checker.available).toEqual({
      current: '1.3.1',
      latest: '9.9.9',
      url: 'https://github.com/oscardvs/zoteus/releases/tag/v9.9.9',
    });
    const cache = JSON.parse(await readFile(join(dataDir, 'update-check.json'), 'utf8'));
    expect(cache.latest).toBe('9.9.9');
  });

  it('reports nothing when already on the latest release', async () => {
    const dataDir = await tempDir();
    const checker = new UpdateChecker({
      currentVersion: '1.3.1',
      dataDir,
      logger: silentLogger,
      enabled: true,
      fetchImpl: async () => ghResponse('v1.3.1'),
    });
    await checker.start();
    expect(checker.available).toBeNull();
  });

  it('uses the cached result within the TTL instead of fetching again', async () => {
    const dataDir = await tempDir();
    const first = new UpdateChecker({
      currentVersion: '1.3.1',
      dataDir,
      logger: silentLogger,
      enabled: true,
      fetchImpl: async () => ghResponse('v9.9.9'),
    });
    await first.start();
    const fetchImpl = vi.fn();
    const second = new UpdateChecker({
      currentVersion: '1.3.1',
      dataDir,
      logger: silentLogger,
      enabled: true,
      fetchImpl,
    });
    await second.start();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(second.available?.latest).toBe('9.9.9');
  });

  it('caches a failed attempt so later sessions do not retry the same day', async () => {
    const dataDir = await tempDir();
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    const first = new UpdateChecker({
      currentVersion: '1.3.1',
      dataDir,
      logger: silentLogger,
      enabled: true,
      fetchImpl: failing,
    });
    await first.start();
    expect(first.available).toBeNull();
    const second = new UpdateChecker({
      currentVersion: '1.3.1',
      dataDir,
      logger: silentLogger,
      enabled: true,
      fetchImpl: failing,
    });
    await second.start();
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', async () => {
    const dataDir = await tempDir();
    const fetchImpl = vi.fn();
    const checker = new UpdateChecker({
      currentVersion: '1.3.1',
      dataDir,
      logger: silentLogger,
      enabled: false,
      fetchImpl,
    });
    await checker.start();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(checker.available).toBeNull();
  });

  it('tolerates a non-OK response', async () => {
    const dataDir = await tempDir();
    const checker = new UpdateChecker({
      currentVersion: '1.3.1',
      dataDir,
      logger: silentLogger,
      enabled: true,
      fetchImpl: async () => new Response('rate limited', { status: 403 }),
    });
    await checker.start();
    expect(checker.available).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAttachmentBytes } from '../../src/features/attachments/bytes.js';

const LOCAL = new TextEncoder().encode('bytes from the desktop app');
const DISK = new TextEncoder().encode('bytes from the storage folder');
const CLOUD = new TextEncoder().encode('bytes from Zotero storage');

let zoteroDataDir: string;

beforeEach(async () => {
  zoteroDataDir = await mkdtemp(join(tmpdir(), 'zoteus-storage-'));
});
afterEach(async () => {
  await rm(zoteroDataDir, { recursive: true, force: true });
});

/** Put a file where Zotero would: `<data dir>/storage/<key>/<name>`. */
async function seedStorage(key: string, name: string, bytes: Uint8Array): Promise<void> {
  const dir = join(zoteroDataDir, 'storage', key);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), bytes);
}

function ctx(over: any = {}) {
  return {
    config: { zoteroDataDir },
    capabilities: { cloud: { userID: 1 }, localApi: false },
    router: { defaultLibrary: () => ({ type: 'user', id: 1 }) },
    web: { downloadFileBytes: vi.fn(async () => ({ bytes: CLOUD, contentType: 'application/pdf' })) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
  } as any;
}

describe('loadAttachmentBytes source order', () => {
  it('prefers the running Zotero desktop app over disk and cloud', async () => {
    await seedStorage('ATT01', 'paper.pdf', DISK);
    const c = ctx({
      capabilities: { cloud: { userID: 1 }, localApi: true },
      local: { downloadFileBytes: vi.fn(async () => LOCAL) },
    });
    const result = await loadAttachmentBytes(c, { key: 'ATT01', filename: 'paper.pdf' });
    expect(result.source).toBe('local-api');
    expect(result.bytes).toEqual(LOCAL);
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
  });

  it('reads the Zotero storage folder when the desktop app is not running', async () => {
    await seedStorage('ATT01', 'paper.pdf', DISK);
    const c = ctx();
    const result = await loadAttachmentBytes(c, { key: 'ATT01', filename: 'paper.pdf' });
    expect(result.source).toBe('storage');
    expect(result.bytes).toEqual(DISK);
    // The whole point: no cloud round trip for a file already on this machine.
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
  });

  it('finds the file in the storage folder without being told its name', async () => {
    await seedStorage('ATT01', 'paper.pdf', DISK);
    await writeFile(join(zoteroDataDir, 'storage', 'ATT01', '.zotero-ft-cache'), 'cached text');
    const result = await loadAttachmentBytes(ctx(), { key: 'ATT01' });
    expect(result.source).toBe('storage');
    expect(result.bytes).toEqual(DISK);
  });

  it('falls back to the cloud when no local copy exists', async () => {
    const c = ctx();
    const result = await loadAttachmentBytes(c, { key: 'ATT01', filename: 'paper.pdf' });
    expect(result.source).toBe('cloud');
    expect(result.bytes).toEqual(CLOUD);
    expect(c.web.downloadFileBytes).toHaveBeenCalledWith({ type: 'user', id: 1 }, 'ATT01');
  });

  it('falls through to the next source when the desktop app fails, rather than giving up', async () => {
    await seedStorage('ATT01', 'paper.pdf', DISK);
    const c = ctx({
      capabilities: { cloud: { userID: 1 }, localApi: true },
      local: {
        downloadFileBytes: vi.fn(async () => {
          throw new Error('Local API file 404 for ATT01');
        }),
      },
    });
    const result = await loadAttachmentBytes(c, { key: 'ATT01', filename: 'paper.pdf' });
    expect(result.source).toBe('storage');
    expect(result.reasons.join(' ')).toMatch(/desktop app could not read it/);
  });

  it('skips the desktop app for an explicit group library, which it may not hold', async () => {
    const c = ctx({
      capabilities: { cloud: { userID: 1 }, localApi: true },
      local: { downloadFileBytes: vi.fn(async () => LOCAL) },
    });
    const result = await loadAttachmentBytes(c, { key: 'ATT01', library: { type: 'group', id: 42 } });
    expect(c.local.downloadFileBytes).not.toHaveBeenCalled();
    expect(result.source).toBe('cloud');
    expect(c.web.downloadFileBytes).toHaveBeenCalledWith({ type: 'group', id: 42 }, 'ATT01');
  });
});

describe('loadAttachmentBytes refusals', () => {
  it('reports why every source failed instead of throwing', async () => {
    const c = ctx({
      web: {
        downloadFileBytes: vi.fn(async () => {
          throw new Error('403 Forbidden');
        }),
      },
    });
    const result = await loadAttachmentBytes(c, { key: 'ATT01' });
    expect(result.bytes).toBeUndefined();
    expect(result.reasons.join(' ')).toMatch(/403 Forbidden/);
  });

  it('does not attempt a cloud download when no cloud key was found', async () => {
    const c = ctx({ capabilities: { cloud: null, localApi: false } });
    const result = await loadAttachmentBytes(c, { key: 'ATT01' });
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
    expect(result.reasons.join(' ')).toMatch(/no cloud API key/);
  });

  it('never leaves the storage folder for a filename that carries a path', async () => {
    // A `filename` comes from library data; `../` in it must not address another folder.
    await writeFile(join(zoteroDataDir, 'secret.txt'), 'not an attachment');
    await mkdir(join(zoteroDataDir, 'storage', 'ATT01'), { recursive: true });
    const c = ctx();
    const result = await loadAttachmentBytes(c, { key: 'ATT01', filename: '../../secret.txt' });
    expect(result.source).toBe('cloud');
    expect(result.bytes).toEqual(CLOUD);
  });

  it('leaves an oversized file on disk unread, and does not download the same bytes', async () => {
    await seedStorage('ATT01', 'paper.pdf', DISK);
    const c = ctx();
    const result = await loadAttachmentBytes(c, { key: 'ATT01', filename: 'paper.pdf', maxBytes: 4 });
    expect(result.bytes).toBeUndefined();
    expect(result.tooLarge).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/larger than/);
    // The cloud copy is the same file: fetching it would only spend the transfer.
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
  });
});

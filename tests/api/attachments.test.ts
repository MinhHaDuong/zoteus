import { describe, it, expect, vi } from 'vitest';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadAttachmentBytes, uploadFile, downloadFile, guessContentType } from '../../src/api/attachments.js';

const lib = { type: 'user', id: 19552201 } as const;

function fakeWeb(overrides: any = {}) {
  return {
    writeItems: vi.fn(async () => ({
      successful: [{ index: 0, key: 'ATT1' }],
      unchanged: [],
      failed: [],
      newLibraryVersion: 1,
    })),
    requestUpload: vi.fn(async () => ({ url: 'https://s3.example/upload', contentType: 'multipart/form-data', prefix: 'PRE', suffix: 'SUF', uploadKey: 'UP1' })),
    uploadBytes: vi.fn(async () => undefined),
    registerUpload: vi.fn(async () => undefined),
    downloadFileBytes: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' })),
    ...overrides,
  } as any;
}

describe('attachments', () => {
  it('guessContentType maps extensions', () => {
    expect(guessContentType('paper.pdf')).toBe('application/pdf');
    expect(guessContentType('weird.xyz')).toBe('application/octet-stream');
  });

  it('uploads a new file through all 5 steps', async () => {
    const fp = join(tmpdir(), `zoteus-upl-${process.pid}.txt`);
    await writeFile(fp, 'hello world');
    const web = fakeWeb();
    const r = await uploadFile(web, lib, { filePath: fp });
    expect(web.writeItems).toHaveBeenCalled();
    expect(web.requestUpload).toHaveBeenCalled();
    expect(web.uploadBytes).toHaveBeenCalled();
    expect(web.registerUpload).toHaveBeenCalledWith(lib, 'ATT1', 'UP1');
    expect(r).toMatchObject({ key: 'ATT1', exists: false });
    await rm(fp);
  });

  it('short-circuits when the file already exists in storage', async () => {
    const fp = join(tmpdir(), `zoteus-upl2-${process.pid}.txt`);
    await writeFile(fp, 'dup');
    const web = fakeWeb({ requestUpload: vi.fn(async () => ({ exists: 1 })) });
    const r = await uploadFile(web, lib, { filePath: fp });
    expect(r.exists).toBe(true);
    expect(web.uploadBytes).not.toHaveBeenCalled();
    expect(web.registerUpload).not.toHaveBeenCalled();
    await rm(fp);
  });

  it('uploads in-memory bytes without touching the filesystem', async () => {
    const web = fakeWeb();
    const r = await uploadAttachmentBytes(web, lib, {
      bytes: new Uint8Array([1, 2, 3, 4]),
      filename: 'paper.pdf',
      parentItem: 'ITEM1',
      contentType: 'application/pdf',
    });
    expect(r).toMatchObject({ key: 'ATT1', exists: false, filename: 'paper.pdf' });
    expect(web.writeItems.mock.calls[0][1][0]).toMatchObject({
      itemType: 'attachment',
      parentItem: 'ITEM1',
      linkMode: 'imported_file',
      filename: 'paper.pdf',
    });
    expect(web.requestUpload.mock.calls[0][2]).toMatchObject({ filesize: 4 });
  });

  it('records a downloaded file as an imported_url that keeps its source', async () => {
    const web = fakeWeb();
    await uploadAttachmentBytes(web, lib, {
      bytes: new Uint8Array([9]),
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      url: 'https://arxiv.org/pdf/2501.12345v1',
    });
    expect(web.writeItems.mock.calls[0][1][0]).toMatchObject({
      linkMode: 'imported_url',
      url: 'https://arxiv.org/pdf/2501.12345v1',
    });
  });

  it('downloads bytes to a path', async () => {
    const out = join(tmpdir(), `zoteus-dl-${process.pid}.bin`);
    const r = await downloadFile(fakeWeb(), lib, 'ATT1', out);
    expect(r.bytes).toBe(3);
    expect((await readFile(out)).length).toBe(3);
    await rm(out);
  });
});

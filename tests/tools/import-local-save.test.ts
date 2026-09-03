import { describe, it, expect, vi } from 'vitest';
import importTool from '../../src/tools/import.js';

/** Minimal ctx for the DOI built-in resolution path (translation-server down). */
function makeCtx(over: any = {}): any {
  return {
    config: { translationServerUrl: 'http://127.0.0.1:1969' },
    capabilities: { cloud: null, localApi: false },
    translation: { isUp: vi.fn(async () => false) },
    scholar: {
      lookup: vi.fn(async () => ({
        title: 'A Scholarly Work',
        authors: ['Ada Lovelace'],
        year: 2024,
        venue: 'Nature',
      })),
    },
    fetcher: { fetch: vi.fn() },
    web: {
      writeItems: vi.fn(async () => ({
        successful: [{ index: 0, key: 'CLOUDKEY', version: 1 }],
        unchanged: [],
        failed: [],
        newLibraryVersion: 1,
      })),
    },
    localWrites: undefined,
    connectorWrites: undefined,
    local: undefined,
    router: { defaultLibrary: () => ({ type: 'user', id: 0 }) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
  };
}

const localWriteResult = {
  successful: [{ index: 0, key: 'LOCALKEY1', version: 7 }],
  unchanged: [],
  failed: [],
  newLibraryVersion: 7,
};

describe('zotero_import save target (DOI without translation-server)', () => {
  it('saves via the desktop local API when a stored grant key exists', async () => {
    const writeItems = vi.fn(async (..._args: any[]) => localWriteResult);
    const ctx = makeCtx({
      capabilities: { cloud: null, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems },
    });
    const res = await importTool.handler(
      { action: 'by_identifier', identifier: '10.1234/example', save_to_library: true },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(writeItems).toHaveBeenCalledTimes(1);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    const sc = res.structuredContent as any;
    expect(sc.target).toBe('local');
    expect(sc.created).toEqual(['LOCALKEY1']);
    expect(sc.source).toBe('scholar');
    // provenance tag is attached to the item sent to Zotero
    expect(writeItems.mock.calls[0][0][0].extra).toContain('resolved:scholar');
  });

  it('saves via the connector protocol when the desktop app is up but no local key is stored', async () => {
    const saveItems = vi.fn(async () => ({ sessionID: 'sess-1', connectorIds: ['c1'] }));
    const ctx = makeCtx({
      capabilities: { cloud: null, localApi: true },
      connectorWrites: { saveItems },
      local: {
        listItems: vi.fn(async () => ({
          data: [{ key: 'DESKKEY1', data: { key: 'DESKKEY1', title: 'A Scholarly Work' } }],
          totalResults: 1,
          lastModifiedVersion: 1,
        })),
      },
    });
    const res = await importTool.handler(
      { action: 'by_identifier', identifier: '10.1234/example', save_to_library: true },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(saveItems).toHaveBeenCalledTimes(1);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    const sc = res.structuredContent as any;
    expect(sc.target).toBe('desktop');
    expect(sc.created).toEqual(['DESKKEY1']);
  });

  it('falls back to the cloud Web API for an explicit group library even when desktop writes exist', async () => {
    const writeItems = vi.fn(async () => localWriteResult);
    const ctx = makeCtx({
      capabilities: { cloud: { userID: 42 }, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems },
    });
    const res = await importTool.handler(
      {
        action: 'by_identifier',
        identifier: '10.1234/example',
        save_to_library: true,
        library_id: 12345,
        library_type: 'group',
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(writeItems).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).toHaveBeenCalledTimes(1);
    expect((res.structuredContent as any).target).toBe('cloud');
    expect((res.structuredContent as any).created).toEqual(['CLOUDKEY']);
  });

  it('falls back to the cloud Web API when the desktop app is not available', async () => {
    const ctx = makeCtx({ capabilities: { cloud: { userID: 42 }, localApi: false } });
    const res = await importTool.handler(
      { action: 'by_identifier', identifier: '10.1234/example', save_to_library: true },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(ctx.web.writeItems).toHaveBeenCalledTimes(1);
    expect((res.structuredContent as any).target).toBe('cloud');
  });

  it('errors with actionable guidance when neither desktop writes nor a cloud key exist', async () => {
    const ctx = makeCtx({ capabilities: { cloud: null, localApi: false } });
    const res = await importTool.handler(
      { action: 'by_identifier', identifier: '10.1234/example', save_to_library: true },
      ctx,
    );
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text).toMatch(/ZOTERO_API_KEY|desktop/i);
  });

  it('attaches attach_url as a stored file on the local-API save path', async () => {
    const writeItems = vi.fn(async (items: any[]) =>
      items[0]?.itemType === 'attachment'
        ? { successful: [{ index: 0, key: 'ATTACHKEY', version: 8 }], unchanged: [], failed: [], newLibraryVersion: 8 }
        : localWriteResult,
    );
    const uploadFile = vi.fn(async (..._args: any[]) => {});
    const ctx = makeCtx({
      capabilities: { cloud: null, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems, uploadFile },
      fetcher: {
        fetch: vi.fn(async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/pdf' } }),
        ),
      },
    });
    const res = await importTool.handler(
      {
        action: 'by_identifier',
        identifier: '10.1234/example',
        save_to_library: true,
        attach_url: 'https://arxiv.org/pdf/2501.12345v1?download=1',
        attach_title: 'Full Text PDF',
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.target).toBe('local');
    expect(sc.warning).toBeUndefined();
    expect(sc.attached).toMatchObject({ key: 'ATTACHKEY', bytes: 4, contentType: 'application/pdf' });
    // The attachment item is a stored (imported_file) child of the item just saved.
    expect(writeItems).toHaveBeenCalledTimes(2);
    expect(writeItems.mock.calls[1][0][0]).toMatchObject({
      itemType: 'attachment',
      parentItem: 'LOCALKEY1',
      linkMode: 'imported_file',
      title: 'Full Text PDF',
      contentType: 'application/pdf',
    });
    // ...and the bytes go up under a bare file name with a .pdf extension.
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile.mock.calls[0][0]).toBe('ATTACHKEY');
    expect(uploadFile.mock.calls[0][1]).toMatchObject({ filename: '2501.12345v1.pdf', contentType: 'application/pdf' });
    expect(uploadFile.mock.calls[0][1].bytes).toHaveLength(4);
  });

  it('keeps a local save successful when the attach_url download fails (warning only)', async () => {
    const writeItems = vi.fn(async () => localWriteResult);
    const uploadFile = vi.fn(async () => {});
    const ctx = makeCtx({
      capabilities: { cloud: null, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems, uploadFile },
      fetcher: { fetch: vi.fn(async () => new Response('nope', { status: 404 })) },
    });
    const res = await importTool.handler(
      {
        action: 'by_identifier',
        identifier: '10.1234/example',
        save_to_library: true,
        attach_url: 'https://example.org/missing.pdf',
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.created).toEqual(['LOCALKEY1']);
    expect(sc.attached).toBeUndefined();
    expect(sc.warning).toMatch(/404/);
    expect(uploadFile).not.toHaveBeenCalled();
    // The failed attachment must not push the import onto another save path.
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('resolves without saving when save_to_library is omitted (no writes at all)', async () => {
    const writeItems = vi.fn(async () => localWriteResult);
    const ctx = makeCtx({
      capabilities: { cloud: null, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems },
    });
    const res = await importTool.handler({ action: 'by_identifier', identifier: '10.1234/example' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(writeItems).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect((res.structuredContent as any).saved).toBe(false);
  });
});

/**
 * The cloud save path is what a remote/hosted Zoteus always takes: the desktop local API
 * listens on the user's own loopback address, so no desktop write path exists there and
 * attach_url has to go through Zotero file storage.
 */
describe('zotero_import attach_url on the cloud save path', () => {
  const cloudCtx = (over: any = {}) =>
    makeCtx({
      capabilities: { cloud: { userID: 19552201, username: 'oscardvs', access: {} }, localApi: false },
      web: {
        writeItems: vi.fn(async (_lib: any, items: any[]) =>
          items[0]?.itemType === 'attachment'
            ? { successful: [{ index: 0, key: 'CLOUDATT', version: 2 }], unchanged: [], failed: [], newLibraryVersion: 2 }
            : { successful: [{ index: 0, key: 'CLOUDKEY', version: 1 }], unchanged: [], failed: [], newLibraryVersion: 1 },
        ),
        requestUpload: vi.fn(async () => ({
          url: 'https://s3.example/upload',
          contentType: 'multipart/form-data',
          prefix: 'PRE',
          suffix: 'SUF',
          uploadKey: 'UP1',
        })),
        uploadBytes: vi.fn(async () => undefined),
        registerUpload: vi.fn(async () => undefined),
      },
      fetcher: {
        fetch: vi.fn(
          async () =>
            new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/pdf' } }),
        ),
      },
      ...over,
    });

  it('uploads the file into Zotero storage instead of warning that it cannot', async () => {
    const ctx = cloudCtx();
    const res = await importTool.handler(
      {
        action: 'by_identifier',
        identifier: '10.1234/example',
        save_to_library: true,
        attach_url: 'https://arxiv.org/pdf/2501.12345v1',
        attach_title: 'Full Text PDF',
      },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.target).toBe('cloud');
    expect(sc.created).toEqual(['CLOUDKEY']);
    expect(sc.warning).toBeUndefined();
    expect(sc.attached).toMatchObject({
      key: 'CLOUDATT',
      bytes: 4,
      contentType: 'application/pdf',
      filename: '2501.12345v1.pdf',
      alreadyInStorage: false,
    });
    expect(ctx.web.writeItems.mock.calls[1][1][0]).toMatchObject({
      itemType: 'attachment',
      parentItem: 'CLOUDKEY',
      linkMode: 'imported_url',
      title: 'Full Text PDF',
      contentType: 'application/pdf',
    });
    expect(ctx.web.uploadBytes).toHaveBeenCalledTimes(1);
    expect(ctx.web.registerUpload).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, 'CLOUDATT', 'UP1');
  });

  it('keeps the import successful when the attachment fails (warning only, no duplicate save)', async () => {
    const ctx = cloudCtx({ fetcher: { fetch: vi.fn(async () => new Response('nope', { status: 404 })) } });
    const res = await importTool.handler(
      {
        action: 'by_identifier',
        identifier: '10.1234/example',
        save_to_library: true,
        attach_url: 'https://example.org/missing.pdf',
      },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.created).toEqual(['CLOUDKEY']);
    expect(sc.attached).toBeUndefined();
    expect(sc.warning).toMatch(/404/);
    expect(ctx.web.writeItems).toHaveBeenCalledTimes(1);
  });
});

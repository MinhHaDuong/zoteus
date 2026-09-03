import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { buildOAuth } from '../../src/auth/router.js';
import { loadConfig } from '../../src/config.js';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe('CIMD AS metadata', () => {
  it('advertises client_id_metadata_document_supported when CIMD is enabled', async () => {
    const config = loadConfig({
      ZOTERO_API_KEY: 'k',
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_OAUTH_MODE: 'passcode',
      ZOTEUS_OAUTH_PASSCODE: 'secret-passcode',
      ZOTEUS_PUBLIC_URL: 'https://zoteus.example.com',
      ZOTEUS_CIMD_ENABLED: 'true',
    });
    const oauth = await buildOAuth(config);
    expect(oauth).toBeDefined();
    const app = express();
    oauth!.mount(app);
    server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.registration_endpoint).toBeTruthy(); // DCR still advertised
  });

  it('omits the flag when CIMD is disabled', async () => {
    const config = loadConfig({
      ZOTERO_API_KEY: 'k',
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_OAUTH_MODE: 'passcode',
      ZOTEUS_OAUTH_PASSCODE: 'secret-passcode',
      ZOTEUS_PUBLIC_URL: 'https://zoteus.example.com',
    });
    const oauth = await buildOAuth(config);
    const app = express();
    oauth!.mount(app);
    server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const meta = (await (
      await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBeUndefined();
  });
});

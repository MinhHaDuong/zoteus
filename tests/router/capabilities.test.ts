import { describe, it, expect, vi } from 'vitest';
import { probeCapabilities } from '../../src/router/capabilities.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/lib/logger.js';

const logger = createLogger('error');

describe('probeCapabilities', () => {
  it('resolves cloud key info and local availability', async () => {
    const cfg = loadConfig({ ZOTERO_API_KEY: 'KEY', ZOTEUS_LOCAL: 'auto' } as any);
    const web = {
      hasKey: true,
      keysCurrent: vi.fn(async () => ({ userID: 19552201, username: 'oscardvs', access: {} })),
    };
    const local = { ping: vi.fn(async () => true) };
    const caps = await probeCapabilities(cfg, { web: web as any, local: local as any, logger });
    expect(caps.cloud?.userID).toBe(19552201);
    expect(caps.localApi).toBe(true);
  });

  it('treats an invalid key as no cloud access without throwing', async () => {
    const cfg = loadConfig({ ZOTERO_API_KEY: 'BAD', ZOTEUS_LOCAL: 'off' } as any);
    const web = {
      hasKey: true,
      keysCurrent: vi.fn(async () => {
        throw new Error('403');
      }),
    };
    const local = { ping: vi.fn(async () => false) };
    const caps = await probeCapabilities(cfg, { web: web as any, local: local as any, logger });
    expect(caps.cloud).toBeNull();
    expect(caps.localApi).toBe(false);
  });

  it('skips the local probe when ZOTEUS_LOCAL=off', async () => {
    const cfg = loadConfig({ ZOTEUS_LOCAL: 'off' } as any);
    const local = { ping: vi.fn(async () => true) };
    const caps = await probeCapabilities(cfg, {
      web: { hasKey: false } as any,
      local: local as any,
      logger,
    });
    expect(local.ping).not.toHaveBeenCalled();
    expect(caps.localApi).toBe(false);
  });

  it('records the group libraries the desktop app is serving', async () => {
    const cfg = loadConfig({ ZOTEUS_LOCAL: 'auto' } as any);
    const local = {
      ping: vi.fn(async () => true),
      listLocalGroupIds: vi.fn(async () => [4321, 8765]),
    };
    const caps = await probeCapabilities(cfg, {
      web: { hasKey: false } as any,
      local: local as any,
      logger,
    });
    expect(caps.localApi).toBe(true);
    expect(caps.localGroupIds).toEqual([4321, 8765]);
    expect(local.listLocalGroupIds).toHaveBeenCalledTimes(1);
  });

  it('degrades to no local groups when the group probe fails', async () => {
    // A pre-Zotero-10 app has no /groups endpoint; that must not sink the whole probe.
    const cfg = loadConfig({ ZOTEUS_LOCAL: 'auto' } as any);
    const local = {
      ping: vi.fn(async () => true),
      listLocalGroupIds: vi.fn(async () => {
        throw new Error('No endpoint found');
      }),
    };
    const caps = await probeCapabilities(cfg, {
      web: { hasKey: false } as any,
      local: local as any,
      logger,
    });
    expect(caps.localApi).toBe(true);
    expect(caps.localGroupIds).toEqual([]);
  });
});

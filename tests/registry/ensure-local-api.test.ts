import { describe, it, expect, vi } from 'vitest';
import { ensureLocalApi } from '../../src/registry/registry.js';
import { loadConfig } from '../../src/config.js';

function makeCtx(opts: { localApi: boolean; up: boolean; groups?: number[]; groupsFail?: boolean }) {
  const local = {
    ping: vi.fn(async () => opts.up),
    listLocalGroupIds: vi.fn(async () => {
      if (opts.groupsFail) throw new Error('Local API 404 for /users/0/groups');
      return opts.groups ?? [];
    }),
  };
  // What the startup probe leaves behind when the app was down: localApi false, no groups.
  const capabilities = { cloud: null, localApi: opts.localApi, localGroupIds: [] as number[] };
  const ctx: any = { config: loadConfig({ ZOTEUS_LOCAL: 'auto' } as any), capabilities, local };
  return { ctx, local, capabilities };
}

describe('ensureLocalApi', () => {
  it('picks up the groups a late-started desktop app holds', async () => {
    const { ctx, local, capabilities } = makeCtx({ localApi: false, up: true, groups: [4321] });
    expect(await ensureLocalApi(ctx)).toBe(true);
    expect(capabilities.localApi).toBe(true);
    // Without the re-probe the startup [] stays frozen, and a keyless local-only user can
    // never read a group the desktop has been holding all along.
    expect(capabilities.localGroupIds).toEqual([4321]);
    expect(local.listLocalGroupIds).toHaveBeenCalledTimes(1);
  });

  it('still reports the app as up when the group re-probe fails', async () => {
    const { ctx, capabilities } = makeCtx({ localApi: false, up: true, groupsFail: true });
    expect(await ensureLocalApi(ctx)).toBe(true);
    expect(capabilities.localApi).toBe(true);
    expect(capabilities.localGroupIds).toEqual([]);
  });

  it('does not probe groups while the app is still down', async () => {
    const { ctx, local, capabilities } = makeCtx({ localApi: false, up: false });
    expect(await ensureLocalApi(ctx)).toBe(false);
    expect(capabilities.localApi).toBe(false);
    expect(local.listLocalGroupIds).not.toHaveBeenCalled();
  });

  it('short-circuits when the startup probe already found the app', async () => {
    const { ctx, local } = makeCtx({ localApi: true, up: true });
    expect(await ensureLocalApi(ctx)).toBe(true);
    expect(local.ping).not.toHaveBeenCalled();
    expect(local.listLocalGroupIds).not.toHaveBeenCalled();
  });

  it('never touches the desktop app when ZOTEUS_LOCAL=off', async () => {
    const { ctx, local } = makeCtx({ localApi: false, up: true });
    ctx.config = loadConfig({ ZOTEUS_LOCAL: 'off' } as any);
    expect(await ensureLocalApi(ctx)).toBe(false);
    expect(local.ping).not.toHaveBeenCalled();
    expect(local.listLocalGroupIds).not.toHaveBeenCalled();
  });
});

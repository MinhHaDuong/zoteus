import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const whoami: ToolDefinition = {
  name: 'zotero_whoami',
  title: 'Zotero identity & access',
  description:
    'Resolve the current Zotero identity (userID, username, display name) and per-library access scopes from the configured API key, and report which library backends are available (cloud Web API and/or the desktop local API). Call this first to discover the userID — never ask the user to type a numeric ID. If no API key is configured, the server runs in local-only read mode against the desktop library (users/0).',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_args, ctx) => {
    const cloud = ctx.router.whoami();
    const lib = ctx.router.defaultLibrary();
    const update = ctx.updates?.available ?? null;
    const structured = {
      cloud: Boolean(cloud),
      userID: cloud?.userID,
      username: cloud?.username,
      displayName: cloud?.displayName,
      access: cloud?.access ?? null,
      localApi: ctx.capabilities.localApi,
      defaultLibrary: lib,
      update,
    };
    let summary = cloud
      ? `Signed in as ${cloud.username} (userID ${cloud.userID}). Local API: ${ctx.capabilities.localApi ? 'available' : 'unavailable'}.`
      : `No cloud API key configured — running in local-only read mode (local API ${ctx.capabilities.localApi ? 'available' : 'unavailable'}).`;
    if (update) {
      const dist = ctx.config?.dist;
      const bundleHint =
        dist === 'dxt' || dist === 'mcpb'
          ? ' Manually installed desktop extensions do not auto-update: tell the user to download the new bundle (zoteus.mcpb) from that page and reinstall it in Claude to upgrade.'
          : '';
      summary += ` Zoteus ${update.latest} is available (installed: ${update.current}): ${update.url}.${bundleHint}`;
    }
    return ok(structured, summary);
  },
};

export default whoami;

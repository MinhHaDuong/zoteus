import type { ZoteusConfig } from '../config.js';
import type { WebApiClient, KeyInfo } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { Logger } from '../lib/logger.js';

export interface Capabilities {
  cloud: KeyInfo | null;
  localApi: boolean;
  /**
   * Group libraries the desktop app serves locally (Zotero 10+). Empty on older
   * versions, and empty when the local API is down — a group the cloud key can see but
   * the desktop does not hold must still be read over the Web API.
   */
  localGroupIds: number[];
}

export interface ProbeDeps {
  web: Pick<WebApiClient, 'hasKey' | 'keysCurrent'>;
  local?: Pick<LocalApiClient, 'ping' | 'listLocalGroupIds'>;
  logger: Logger;
}

export async function probeCapabilities(
  config: ZoteusConfig,
  deps: ProbeDeps,
): Promise<Capabilities> {
  const cloudPromise: Promise<KeyInfo | null> = deps.web.hasKey
    ? deps.web
        .keysCurrent()
        .then((info) => info)
        .catch((err) => {
          deps.logger.warn('Cloud key probe failed:', String(err));
          return null;
        })
    : Promise.resolve(null);

  // The desktop app may be mid-startup when zoteus boots; a single instant ping can
  // race it and wrongly disable every desktop write path for the process lifetime.
  const localPromise: Promise<boolean> =
    config.local !== 'off' && deps.local
      ? (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            if (await deps.local!.ping().catch(() => false)) return true;
            await new Promise((r) => setTimeout(r, 600));
          }
          return false;
        })()
      : Promise.resolve(false);

  const [cloud, localApi] = await Promise.all([cloudPromise, localPromise]);
  const localGroupIds =
    localApi && deps.local?.listLocalGroupIds
      ? await deps.local.listLocalGroupIds().catch(() => [])
      : [];
  deps.logger.info(
    `Capabilities: cloud=${cloud ? `user ${cloud.userID}` : 'none'}, localApi=${localApi}` +
      `, localGroups=${localGroupIds.length}`,
  );
  return { cloud, localApi, localGroupIds };
}

import type { ZoteusConfig } from '../config.js';
import type { WebApiClient, KeyInfo } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { Logger } from '../lib/logger.js';

export interface Capabilities {
  cloud: KeyInfo | null;
  localApi: boolean;
}

export interface ProbeDeps {
  web: Pick<WebApiClient, 'hasKey' | 'keysCurrent'>;
  local?: Pick<LocalApiClient, 'ping'>;
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

  const localPromise: Promise<boolean> =
    config.local !== 'off' && deps.local ? deps.local.ping().catch(() => false) : Promise.resolve(false);

  const [cloud, localApi] = await Promise.all([cloudPromise, localPromise]);
  deps.logger.info(
    `Capabilities: cloud=${cloud ? `user ${cloud.userID}` : 'none'}, localApi=${localApi}`,
  );
  return { cloud, localApi };
}

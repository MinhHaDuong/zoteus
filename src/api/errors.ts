export interface ZoteroApiErrorInit {
  status: number;
  message: string;
  retryAfter?: number;
  currentVersion?: number;
  body?: string;
}

export class ZoteroApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;
  readonly currentVersion?: number;
  readonly body?: string;

  constructor(init: ZoteroApiErrorInit) {
    super(init.message);
    this.name = 'ZoteroApiError';
    this.status = init.status;
    this.retryAfter = init.retryAfter;
    this.currentVersion = init.currentVersion;
    this.body = init.body;
  }
}

/**
 * The facts about the failed request that its remedy depends on.
 *
 * A 403 is the reason this exists. Zotero spends that one status on several unrelated
 * refusals whose remedies contradict each other, and which of them applies is decided by
 * three things the response itself does not carry: which library was addressed, whether
 * the request was a read or a write, and whether a key was sent at all. Without them the
 * message could only list every possibility, so a key-free read of a personal library was
 * answered with four clauses about group write permissions (#79).
 */
export interface RequestContext {
  /** HTTP method of the failed request, so a read is never answered with a write's fix. */
  method?: string;
  /** Its full URL. The library it addressed is a path segment of it. */
  url?: string;
  /** Whether a cloud API key was sent with it. */
  hasKey?: boolean;
}

const KEY_SETTINGS_URL = 'https://www.zotero.org/settings/keys';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The library a Zotero API path addresses, or null for the key and schema endpoints. */
function libraryOf(url?: string): { type: 'user' | 'group'; id: string } | null {
  const m = /\/(users|groups)\/(\d+)/.exec(url ?? '');
  if (!m?.[2]) return null;
  return { type: m[1] === 'users' ? 'user' : 'group', id: m[2] };
}

/**
 * What a 403 means for THIS request. Every branch below is reached only when the facts it
 * names have been checked; where they are unknown (no context passed) the last branch says
 * only what is certain of any 403.
 */
function forbidden(detail: string, req?: RequestContext): string {
  const lib = libraryOf(req?.url);
  const isWrite = req?.method ? WRITE_METHODS.has(req.method.toUpperCase()) : undefined;

  if (req?.url?.includes('/keys/current')) {
    return (
      `Zotero rejected the API key itself${detail}. ZOTERO_API_KEY is invalid, revoked, or mistyped: check it at ` +
      `${KEY_SETTINGS_URL}, or unset it to run key-free against the Zotero desktop app.`
    );
  }

  if (req?.hasKey === false) {
    // No key was sent, so no permission on any key explains this and none of them is the
    // fix. What key-free mode can reach is the desktop app, which is addressed differently.
    if (lib?.type === 'user') {
      return (
        `Access denied${detail}: the request went to api.zotero.org with no API key (ZOTERO_API_KEY is unset), and ` +
        `users/${lib.id} is not readable anonymously. Key-free, the library this server can reach is the one the running ` +
        `Zotero desktop app serves, and it is addressed as library_id:0 (or by passing no library_type/library_id at ` +
        `all, which is the default). library_id:${lib.id} addresses users/${lib.id} on api.zotero.org instead, so the ` +
        `call left the machine. Set ZOTERO_API_KEY (${KEY_SETTINGS_URL}) only if the cloud copy is what you meant. ` +
        `zotero_whoami reports which mode this server is in and what its default library is.`
      );
    }
    if (lib?.type === 'group') {
      return (
        `Access denied${detail}: the request went to api.zotero.org with no API key (ZOTERO_API_KEY is unset), and ` +
        `group ${lib.id} does not serve anonymous requests. A private group needs a cloud key whose owner is a member of ` +
        `it (${KEY_SETTINGS_URL}). A group the running desktop app holds is served locally with no key at all; ` +
        `zotero_groups lists the groups reachable right now.`
      );
    }
    return (
      `Access denied${detail}: the request went to api.zotero.org with no API key (ZOTERO_API_KEY is unset). Set one at ` +
      `${KEY_SETTINGS_URL}, or address the library the running Zotero desktop app serves (library_id:0).`
    );
  }

  if (lib && isWrite === false) {
    // A read. Write permission cannot be the cause, so it must not be the advice.
    return lib.type === 'group'
      ? `Access denied${detail}: the API key cannot READ group ${lib.id}. Either its owner is not a member of that ` +
          `group, or the key was created without access to it. Grant it at ${KEY_SETTINGS_URL}, and confirm the id ` +
          `with zotero_groups. Write access is a separate setting and is not what this read needed.`
      : `Access denied${detail}: the API key cannot READ users/${lib.id}. A personal library is private to its owner ` +
          `and no key setting shares one, so this is another account's library unless zotero_whoami reports ${lib.id} ` +
          `as the key's own user id. Libraries shared with you are group libraries; zotero_groups lists them.`;
  }

  if (lib && isWrite === true) {
    // Group writes are where a 403 usually lands: the key's group scope and the group's
    // own edit setting are separate gates, and "Access denied" alone left callers retrying
    // a request that can never succeed (#74).
    return lib.type === 'group'
      ? `Access denied${detail}: the API key cannot WRITE to group ${lib.id}. This is one of: the key has no write ` +
          `access to that group (edit it at ${KEY_SETTINGS_URL}), the key's owner is not a member of the group, or the ` +
          `group only lets admins edit the library (check "Library Editing" in the group's settings on zotero.org). ` +
          `zotero_groups shows which groups the key can reach.`
      : `Access denied${detail}: the API key cannot WRITE to users/${lib.id}. If that is your own account the key is ` +
          `read-only: grant it "Allow write access" at ${KEY_SETTINGS_URL}, or let the running Zotero desktop app take ` +
          `the write instead (no key needed). Another account's personal library cannot be written at all.`;
  }

  return (
    `Access denied${detail}. The API key does not cover this library or this operation: check what it may do at ` +
    `${KEY_SETTINGS_URL}, and list the groups it can reach with zotero_groups. A group can also be set so that only ` +
    `admins may edit its library, which no key setting overrides.`
  );
}

/**
 * Turn a Zotero HTTP failure into a message the model can act on.
 *
 * `req` is optional so a caller that has no request context still gets a message; the
 * statuses that need it say less rather than guessing.
 */
export function actionableMessage(
  status: number,
  body: string,
  headers: Headers,
  req?: RequestContext,
): string {
  const detail = body?.trim() ? ` (${body.trim().slice(0, 200)})` : '';
  switch (status) {
    case 400:
      return `Zotero rejected the request as malformed${detail}. Check field names and itemType against the schema (zotero_schema).`;
    case 403:
      return forbidden(detail, req);
    case 404:
      return `Not found${detail}. The item/collection key or library may be wrong.`;
    case 409:
      return `The target library is locked (sync in progress)${detail}. Retry shortly.`;
    case 412: {
      const v = headers.get('last-modified-version');
      return `The object changed on the server since you fetched it${v ? ` (current version ${v})` : ''}. Re-fetch it with zotero_get_item and retry the write with the new version.`;
    }
    case 413:
      return `Request too large${detail}. Reduce batch size to <= 50 objects, or the file exceeds your storage quota.`;
    case 428:
      return `Missing precondition${detail}. A version (If-Unmodified-Since-Version) is required for this write.`;
    case 429: {
      const ra = headers.get('retry-after');
      return `Rate limited by Zotero. Wait ${ra ?? 'a few'} seconds, then retry sequentially (avoid parallel batches) and keep responses concise${ra ? ` (Retry-After: ${ra}s)` : ''}.`;
    }
    case 503: {
      const ra = headers.get('retry-after');
      return `Zotero is temporarily unavailable. Retry sequentially after ${ra ?? 'a short delay'} (avoid parallel batches)${ra ? ` (${ra}s)` : ''}.`;
    }
    default:
      return `Zotero API error ${status}${detail}.`;
  }
}

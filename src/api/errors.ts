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

/** Turn a Zotero HTTP failure into a message the model can act on. */
export function actionableMessage(status: number, body: string, headers: Headers): string {
  const detail = body?.trim() ? ` (${body.trim().slice(0, 200)})` : '';
  switch (status) {
    case 400:
      return `Zotero rejected the request as malformed${detail}. Check field names and itemType against the schema (zotero_schema).`;
    case 403:
      // Three different things wear this status, and the remedy differs for each, so name
      // all three rather than the one (#74). Group writes are where it usually lands: the
      // key's group scope and the group's own edit setting are separate gates, and
      // "Access denied" alone left callers retrying a request that can never succeed.
      return (
        `Access denied${detail}. For a group library this is one of: your API key has no write access to that group ` +
        `(edit it at https://www.zotero.org/settings/keys), the key's owner is not a member of the group, or the group ` +
        `itself only lets admins edit the library (check "Library Editing" in the group's settings on zotero.org). ` +
        `For your personal library it means the key is read-only. zotero_groups shows which groups the key can reach.`
      );
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

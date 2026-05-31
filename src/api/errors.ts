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
      return `Access denied${detail}. Your API key may lack permission for this library or operation.`;
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

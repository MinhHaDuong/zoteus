import type { ZoteusConfig } from '../config.js';
import type { Capabilities } from './capabilities.js';
import type { WebApiClient, LibraryRef, ItemQuery, ListResult, KeyInfo } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';

export interface LibraryRouterOptions {
  config: ZoteusConfig;
  capabilities: Capabilities;
  web: WebApiClient;
  local?: LocalApiClient;
}

export interface ReadOpts {
  library?: LibraryRef;
}

/**
 * Decides whether a READ is served by the desktop local API or the cloud Web API.
 * Rule: use local only for the default personal (user) library when the local API
 * is up and not disabled; everything else (group libraries, or local down) -> cloud.
 */
export class LibraryRouter {
  private readonly config: ZoteusConfig;
  private readonly capabilities: Capabilities;
  private readonly web: WebApiClient;
  private readonly local?: LocalApiClient;

  constructor(opts: LibraryRouterOptions) {
    this.config = opts.config;
    this.capabilities = opts.capabilities;
    this.web = opts.web;
    this.local = opts.local;
  }

  whoami(): KeyInfo | null {
    return this.capabilities.cloud;
  }

  defaultLibrary(): LibraryRef {
    if (this.config.libraryId) return { type: this.config.libraryType, id: this.config.libraryId };
    if (this.capabilities.cloud) return { type: 'user', id: this.capabilities.cloud.userID };
    // Local-only mode: the desktop personal library is addressed as users/0.
    return { type: 'user', id: 0 };
  }

  private useLocal(library: LibraryRef): boolean {
    if (!this.local || !this.capabilities.localApi || this.config.local === 'off') return false;
    const def = this.defaultLibrary();
    // Local API only serves the personal library (users/0 maps to the default user library).
    return library.type === 'user' && (library.id === def.id || library.id === 0);
  }

  async searchItems(query: ItemQuery & ReadOpts = {}): Promise<ListResult> {
    const { library, ...q } = query;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib)) return this.local!.listItems(q);
    return this.web.listItems(lib, q);
  }

  async getItem(
    key: string,
    opts: ReadOpts & { include?: string; format?: string } = {},
  ): Promise<any> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib)) return this.local!.getItem(key, rest);
    return this.web.getItem(lib, key, rest);
  }

  async getItemChildren(key: string, opts: ReadOpts & ItemQuery = {}): Promise<ListResult> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    // Prefer the desktop app for the personal library (local-only mode has no cloud
    // fallback — hitting api.zotero.org with user id 0 yields "Invalid user ID").
    if (this.useLocal(lib)) return this.local!.getItemChildren(key, rest);
    return this.web.getItemChildren(lib, key, rest);
  }

  async listCollections(
    opts: ReadOpts & { top?: boolean; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib)) return this.local!.listCollections(rest);
    return this.web.listCollections(lib, rest);
  }
}

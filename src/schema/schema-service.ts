import type { WebApiClient } from '../api/web-client.js';
import { validateItem, type ValidationResult } from './validate.js';

export interface ZoteroSchema {
  version: number;
  itemTypes: Array<{
    itemType: string;
    fields?: Array<{ field: string; baseField?: string }>;
    creatorTypes?: Array<{ creatorType: string; primary?: boolean }>;
  }>;
  [key: string]: unknown;
}

export interface SchemaServiceOptions {
  web: Pick<WebApiClient, 'getSchema'>;
}

/** Fetches and caches the global Zotero schema (item types, fields, creator types). */
export class SchemaService {
  private readonly web: Pick<WebApiClient, 'getSchema'>;
  private cache?: ZoteroSchema;
  private inflight?: Promise<ZoteroSchema>;

  constructor(opts: SchemaServiceOptions) {
    this.web = opts.web;
  }

  async getSchema(): Promise<ZoteroSchema> {
    if (this.cache) return this.cache;
    if (!this.inflight) {
      this.inflight = this.web.getSchema().then((s: ZoteroSchema) => {
        this.cache = s;
        this.inflight = undefined;
        return s;
      });
    }
    return this.inflight;
  }

  async itemTypeNames(): Promise<string[]> {
    const schema = await this.getSchema();
    return schema.itemTypes.map((t) => t.itemType);
  }

  async validateItem(item: any): Promise<ValidationResult> {
    return validateItem(await this.getSchema(), item);
  }
}

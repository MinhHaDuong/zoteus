import { callMCPTool } from '../runtime.js';

/**
 * List Zotero groups — List the group libraries the current API key can access, with each group's id, name, type, item count, and edit permissions. Use a returned group id with the `library_id`/`library_type:"group"` parameters of other tools to operate on that group library. Requires a cloud API key.
 * Takes no parameters.
 */
export function groups(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_groups', input);
}

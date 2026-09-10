import { callMCPTool } from '../runtime.js';

/**
 * List Zotero groups — List the group libraries this server can reach, with each group's id and name. Use a returned group id with the `library_id`/`library_type:"group"` parameters of other tools to operate on that group library; `library_type` alone does not address a group. With a cloud API key each group the key can access is listed with its type, item count, description and edit permissions. Without a key the list falls back to the group libraries a running Zotero 10+ desktop app holds, which are exactly the groups still readable, key-free, from that app: those rows carry id, name, description and the desktop's
 * Takes no parameters.
 */
export function groups(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_groups', input);
}

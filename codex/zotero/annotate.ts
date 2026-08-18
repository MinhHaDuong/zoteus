import { callMCPTool } from '../runtime.js';

/**
 * Annotate a PDF (highlights, notes) — Add or delete Zotero PDF annotations (highlights, underlines, notes) — the same objects you create in the Zotero PDF reader. `action:"add"` needs `parent` (a regular item key OR a PDF attachment key) and `annotations`: each with `type` (highlight|note|underline, default highlight), `text` (the exact highlighted passage), optional `comment`, `color`, `page` (0-based page index), and `position` ({"pageIndex":N,"rects":[[x1,y1,x2,y2],...]} in PDF points with bottom-left origin — without a position a highlight cannot render in place). `action:"delete"` trashes the annotations in `annotation_keys`.
 * Params: action, parent, annotations, annotation_keys, library_type, library_id.
 */
export function annotate(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_annotate', input);
}

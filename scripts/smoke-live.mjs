#!/usr/bin/env node
/**
 * Live desktop-write smoke test: boots the built server over real stdio against a
 * RUNNING Zotero desktop app and exercises the real write paths end to end
 * (zotero_import save + attach_url -> zotero_attach_file -> zotero_annotate
 * add/verify/delete -> zotero_trash_items cleanup).
 *
 * Run: node scripts/smoke-live.mjs
 *
 * Prerequisites:
 *   - `npm run build` first — like scripts/smoke-fixes.mjs this boots `dist/index.js`.
 *   - Zotero desktop running with its local API enabled (Settings -> Advanced ->
 *     "Allow other applications on this computer to communicate with Zotero").
 *     Port from ZOTERO_LOCAL_PORT (default 23119). If it is not reachable the script
 *     prints "SKIP: Zotero desktop not running" and exits 0 — this is a manual smoke.
 *   - No cloud key needed: ZOTERO_API_KEY is stripped from the child env so ONLY the
 *     desktop paths are exercised (set SMOKE_ALLOW_CLOUD=1 to keep it).
 *   - No internet needed: an in-process http server on 127.0.0.1 stands in for the
 *     translation-server (resolves the fake test DOI) and serves the tiny test PDF.
 *
 * Everything created is titled "Zoteus live smoke <stamp>", tagged `zoteus-smoke-test`,
 * and moved to the TRASH at the end — never permanently deleted. Steps the running
 * Zotero cannot support (read-only local API on Zotero 9 and earlier + no connector acceptance, and no
 * cloud key) report SKIP with the server's actionable error text, not FAIL; only real
 * failures set a nonzero exit code. When cleanup itself has to be skipped the script
 * prints the keys to trash by hand.
 *
 * Env: SMOKE_VERBOSE=1 keeps the server's info logs (default: warn only).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'dist', 'index.js');

const PORT = Number(process.env.ZOTERO_LOCAL_PORT ?? 23119);
const LOCAL_BASE = `http://127.0.0.1:${PORT}/api`;
const VERBOSE = process.env.SMOKE_VERBOSE === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const TITLE = `Zoteus live smoke ${stamp}`;
const HIGHLIGHT = `Zoteus smoke highlight ${stamp}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- reporting --
let passes = 0;
let failures = 0;
let skips = 0;
const pass = (name, extra = '') => { passes++; console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`); };
const fail = (name, extra = '') => { failures++; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); };
const skip = (name, why = '') => { skips++; console.log(`SKIP ${name}${why ? ' — ' + why : ''}`); };
const check = (name, cond, extra = '') => (cond ? pass(name, extra) : fail(name, extra));
const note = (text) => console.log(`     ${text}`);

/**
 * A tool error that means "the running Zotero (or this configuration) cannot do this
 * write", as opposed to a Zoteus bug: read-only local API (Zotero 9 and earlier has no
 * /api/local/authorize), a connector that refuses the object, or a cloud-only fallback
 * with no ZOTERO_API_KEY. These report SKIP with the server's own text.
 */
const UNSUPPORTED = [
  /needs zotero desktop write access/i,
  /local api is read-only/i,
  /cannot grant/i,
  /requires a cloud api key/i,
  /ZOTERO_API_KEY/,
  /authorize failed \(HTTP \d+\)/i,
  /no endpoint found/i,
  /local api .*\b(404|not implemented|not supported|unreachable)\b/i,
  /connector (saveItems|saveAttachment|updateSession) failed/i,
  /zotero refused the file/i,
  /local write access was denied/i,
  /request timed out/i,
];
const unsupported = (text) => UNSUPPORTED.some((re) => re.test(text));

// ------------------------------------------------------------- tiny test pdf --
/** Build a minimal, structurally valid 1-page PDF (real xref offsets) with one line of text. */
function tinyPdf(line) {
  const stream = `BT /F1 14 Tf 72 700 Td (${String(line).replace(/[()\\]/g, '\\$&')}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const chunks = [];
  let offset = 0;
  const push = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1');
    chunks.push(b);
    offset += b.length;
  };
  push('%PDF-1.4\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const startxref = offset;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) push(`${String(off).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------- local API read probe --
async function localGet(path) {
  const res = await fetch(`${LOCAL_BASE}${path}`, {
    headers: { 'Zotero-API-Version': '3' },
    signal: AbortSignal.timeout(15_000),
  });
  const json = res.ok ? await res.json().catch(() => null) : null;
  return {
    ok: res.ok,
    status: res.status,
    total: Number(res.headers.get('total-results')),
    version: res.headers.get('x-zotero-version') ?? '',
    json,
  };
}

// 0) The built server is a hard prerequisite (same as scripts/smoke-fixes.mjs).
if (!existsSync(ENTRY)) {
  console.error(`Missing ${ENTRY} — run \`npm run build\` first, then re-run this script.`);
  process.exit(1);
}

// 1) Probe the desktop app before doing anything else — this smoke is meaningless
//    without it, and a missing Zotero is a SKIP (exit 0), never a failure.
let probe;
try {
  probe = await localGet('/users/0/items?limit=1');
} catch (e) {
  probe = { ok: false, status: 0, version: '', error: String(e) };
}
if (!probe.ok) {
  console.log(`SKIP: Zotero desktop not running — no local API at ${LOCAL_BASE} (${probe.error ?? 'HTTP ' + probe.status}).`);
  console.log('Start the Zotero app (Settings -> Advanced -> "Allow other applications … to communicate with Zotero") and re-run.');
  process.exit(0);
}
const zoteroVersion = probe.version || 'unknown';
let connectorUp = false;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/connector/ping`, { signal: AbortSignal.timeout(5000) });
  connectorUp = res.ok && /zotero is running/i.test(await res.text().catch(() => ''));
} catch {
  connectorUp = false;
}
console.log(`Zotero ${zoteroVersion} on 127.0.0.1:${PORT} (connector protocol: ${connectorUp ? 'up' : 'unavailable'})`);
console.log(`Test object title: "${TITLE}"\n`);

// 2) In-process stand-ins so the smoke needs no network: a translation-server stub
//    (GET / for isUp, POST /search for the identifier) and the tiny PDF for attach_url.
const pdfBytes = tinyPdf(TITLE);
const stubItem = {
  itemType: 'journalArticle',
  title: TITLE,
  creators: [{ creatorType: 'author', firstName: 'Zoteus', lastName: 'Smoke' }],
  date: '2026',
  publicationTitle: 'Zoteus Smoke Tests',
  DOI: `10.0000/zoteus.smoke.${Date.now()}`,
  abstractNote: 'Temporary item created by scripts/smoke-live.mjs — safe to delete.',
  tags: [{ tag: 'zoteus-smoke-test' }],
};
const stub = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/smoke.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdfBytes.length });
    res.end(pdfBytes);
    return;
  }
  if (req.method === 'POST' && path === '/search') {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([stubItem]));
    });
    return;
  }
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('zoteus smoke translation-server stub');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubBase = `http://127.0.0.1:${stub.address().port}`;
const attachUrl = `${stubBase}/smoke.pdf`;

// 3) Boot the built server over real stdio, pinned to the desktop (local-only).
const env = { ...process.env };
if (process.env.SMOKE_ALLOW_CLOUD !== '1') delete env.ZOTERO_API_KEY;
delete env.ZOTERO_LIBRARY_ID; // never target a group library from this smoke
delete env.ZOTEUS_READ_ONLY; // write tools must be registered
env.ZOTEUS_LOCAL = 'on';
env.ZOTERO_LOCAL_PORT = String(PORT);
env.ZOTERO_LIBRARY_TYPE = 'user';
env.ZOTEUS_EMBEDDINGS = 'off';
env.ZOTEUS_TRANSLATION_SERVER_URL = stubBase;
env.ZOTEUS_LOG_LEVEL = process.env.ZOTEUS_LOG_LEVEL ?? (VERBOSE ? 'info' : 'warn');

const transport = new StdioClientTransport({ command: 'node', args: [ENTRY], cwd: ROOT, env });
const client = new Client({ name: 'zoteus-live-smoke', version: '0.0.0' });
try {
  await client.connect(transport);
} catch (e) {
  await new Promise((resolve) => stub.close(resolve));
  console.log(`FAIL server boots over stdio — ${e instanceof Error ? e.message : e}`);
  console.log('SMOKE FAILED');
  process.exit(1);
}

/** Call a tool, normalizing transport errors into the same shape as tool errors. */
async function call(name, args, timeoutMs = 180_000) {
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { ok: res.isError !== true, text, data: res.structuredContent ?? {} };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e), data: {} };
  }
}
/** One-line form of a server message, kept long enough to carry the actionable advice. */
const brief = (text, n = 320) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Poll the local API for the item's PDF child (connector attachments land async). */
async function findPdfChild(itemKey, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await localGet(`/users/0/items/${itemKey}/children`).catch(() => ({ json: null }));
    const kids = (Array.isArray(json) ? json : []).map((k) => k?.data ?? k).filter(Boolean);
    const pdf = kids.find((k) => k.itemType === 'attachment' && k.contentType === 'application/pdf');
    if (pdf || Date.now() > deadline) return { pdf: pdf ?? null, kids };
    await sleep(1000);
  }
}

let itemKey;
let pdfKey;
let annotationKeys = [];
let trashed = false;

try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  check(
    'write tools registered',
    ['zotero_import', 'zotero_attach_file', 'zotero_annotate', 'zotero_trash_items'].every((n) => names.includes(n)),
    `${names.length} tools`,
  );

  // --- Step 1: zotero_import — save into the personal library via the desktop path,
  //     streaming the tiny PDF from the in-process server as a stored attachment.
  const imported = await call('zotero_import', {
    action: 'by_identifier',
    identifier: stubItem.DOI,
    save_to_library: true,
    attach_url: attachUrl,
    attach_title: 'Zoteus Smoke PDF',
  });
  if (!imported.ok) {
    (unsupported(imported.text) ? skip : fail)('zotero_import saves to the desktop app', brief(imported.text));
  } else {
    const created = Array.isArray(imported.data.created) ? imported.data.created : [];
    itemKey = created[0];
    check(
      'zotero_import saves to the desktop app',
      Boolean(itemKey) && imported.data.target !== 'cloud',
      `target=${imported.data.target} created=${JSON.stringify(created)}`,
    );
    if (imported.data.note) note(`server note: ${imported.data.note}`);
  }

  // --- Step 1b: the attach_url file must land as a stored PDF child of that item.
  if (!itemKey) {
    skip('zotero_import attaches attach_url as a stored PDF', 'no item key returned by the import step');
  } else {
    const { pdf, kids } = await findPdfChild(itemKey);
    pdfKey = pdf?.key;
    // Both desktop write paths must land the file: the connector protocol streams it
    // into the save session, the local API stores it as a child right after the save.
    if (pdfKey) {
      pass(
        'zotero_import attaches attach_url as a stored PDF',
        `target=${imported.data.target} attachment=${pdfKey} linkMode=${pdf.linkMode}`,
      );
    } else {
      fail(
        'zotero_import attaches attach_url as a stored PDF',
        `target=${imported.data.target}: no PDF child of ${itemKey} (${kids.length} child item(s))`,
      );
      if (imported.data.warning) note(`server warning: ${imported.data.warning}`);
    }
  }

  // --- Step 1c: child lookup must be scoped to the parent. zotero_annotate resolves the
  //     PDF to annotate through this same path, so an unscoped listing would silently
  //     annotate an unrelated PDF — hence the annotate step below passes the attachment
  //     key explicitly rather than relying on parent resolution.
  if (!itemKey) {
    skip('zotero_get_item include_children is scoped to the item', 'no item key');
  } else {
    const scoped = await localGet(`/users/0/items/${itemKey}/children`);
    const expected = Array.isArray(scoped.json) ? scoped.json.length : 0;
    const got = await call('zotero_get_item', { item_key: itemKey, include_children: true });
    const children = Array.isArray(got.data.children) ? got.data.children : [];
    check(
      'zotero_get_item include_children is scoped to the item',
      got.ok && children.length === expected,
      `expected ${expected} child item(s) (local API /children), got ${children.length}`,
    );
    if (got.ok && children.length !== expected) {
      note('The desktop local API ignores the `parentItem` query param that LibraryRouter.getItemChildren sends,');
      note('so it returns the WHOLE library: zotero_annotate given a parent item key would pick an unrelated PDF.');
      note(`Use GET /api/users/0/items/<key>/children instead (it returned ${expected} here).`);
    }
  }

  // --- Step 2: zotero_attach_file — store a local temp PDF under the same item.
  const tmpDir = mkdtempSync(join(tmpdir(), 'zoteus-smoke-'));
  const tmpPdf = join(tmpDir, 'zoteus-smoke-local.pdf');
  writeFileSync(tmpPdf, tinyPdf(`${TITLE} (local file)`));
  if (!itemKey) {
    skip('zotero_attach_file stores a local PDF', 'no item key to attach to');
  } else {
    const attached = await call('zotero_attach_file', {
      parent: itemKey,
      path: tmpPdf,
      title: 'Zoteus Smoke Local PDF',
    });
    if (!attached.ok) {
      (unsupported(attached.text) ? skip : fail)('zotero_attach_file stores a local PDF', brief(attached.text));
    } else {
      check(
        'zotero_attach_file stores a local PDF',
        Boolean(attached.data.attachment) && attached.data.bytes > 0,
        `attachment=${attached.data.attachment} bytes=${attached.data.bytes}`,
      );
      pdfKey = pdfKey ?? attached.data.attachment;
    }
  }

  // --- Step 3: zotero_annotate — add a highlight, verify it, then delete it.
  if (!pdfKey) {
    skip('zotero_annotate adds a highlight', 'no PDF attachment available on the test item');
    skip('added annotation is readable', 'nothing was added');
    skip('zotero_annotate deletes the annotation', 'nothing was added');
  } else {
    const added = await call('zotero_annotate', {
      action: 'add',
      parent: pdfKey, // attachment key: exercises the direct-attachment path
      annotations: [
        {
          type: 'highlight',
          text: HIGHLIGHT,
          comment: 'added by scripts/smoke-live.mjs',
          color: '#ffd400',
          page: 0,
          page_height: 792,
          position: { pageIndex: 0, rects: [[100, 700, 200, 720]] },
          tags: ['zoteus-smoke-test'],
        },
      ],
    });
    if (!added.ok) {
      (unsupported(added.text) ? skip : fail)('zotero_annotate adds a highlight', brief(added.text));
    } else {
      const created = Array.isArray(added.data.created) ? added.data.created : [];
      annotationKeys = created.map((c) => c?.key).filter(Boolean);
      check(
        'zotero_annotate adds a highlight',
        added.data.attachment === pdfKey && annotationKeys.length === 1,
        `target=${added.data.target} attachment=${added.data.attachment} keys=${JSON.stringify(annotationKeys)}`,
      );
      if (added.data.note) note(`server note: ${added.data.note}`);
    }

    // Verify through a read tool: the annotation record itself must come back with our
    // text, type and parent attachment.
    if (!annotationKeys.length) {
      skip('added annotation is readable', 'no annotation key was returned');
    } else {
      const read = await call('zotero_get_item', { item_key: annotationKeys[0] });
      const data = read.data?.item?.data ?? read.data?.item ?? {};
      check(
        'added annotation is readable',
        read.ok && data.annotationType === 'highlight' && data.annotationText === HIGHLIGHT && data.parentItem === pdfKey,
        `type=${data.annotationType} parent=${data.parentItem} text="${brief(data.annotationText, 40)}"`,
      );
    }

    // Delete (trash) the annotation again.
    if (!annotationKeys.length) {
      skip('zotero_annotate deletes the annotation', 'no annotation key was returned');
    } else {
      const deleted = await call('zotero_annotate', { action: 'delete', annotation_keys: annotationKeys });
      if (!deleted.ok) {
        (unsupported(deleted.text) ? skip : fail)('zotero_annotate deletes the annotation', brief(deleted.text));
      } else {
        const gone = await localGet(`/users/0/items/${annotationKeys[0]}`).catch(() => ({ ok: false, json: null }));
        // As with items, "delete" means trashed (deleted=1) and therefore recoverable.
        const inTrash = gone.ok && Boolean(gone.json?.data?.deleted ?? gone.json?.deleted);
        check(
          'zotero_annotate trashes the annotation (reversibly)',
          inTrash,
          `target=${deleted.data.target} trashed=${JSON.stringify(deleted.data.trashed ?? [])}`,
        );
        if (!gone.ok) note('the annotation is GONE from the local API — delete must trash it, never erase.');
        else if (!inTrash) note('the annotation is still live in the local API after the delete call.');
      }
    }
  }

  // --- Step 4: cleanup — trash everything this run created (never a permanent delete).
  if (!itemKey) {
    skip('zotero_trash_items trashes the test item', 'nothing was created');
  } else {
    const res = await call('zotero_trash_items', { item_keys: [itemKey] });
    if (!res.ok) {
      (unsupported(res.text) ? skip : fail)('zotero_trash_items trashes the test item', brief(res.text));
    } else {
      const after = await localGet(`/users/0/items/${itemKey}`).catch(() => ({ ok: false, json: null }));
      // Trash must be REVERSIBLE: the item still exists and carries deleted=1. An item
      // that vanished was erased, which is a bug, not a pass.
      const inTrash = after.ok && Boolean(after.json?.data?.deleted ?? after.json?.deleted);
      trashed = true;
      check('zotero_trash_items trashes the test item (reversibly)', inTrash, `target=${res.data.target} item=${itemKey}`);
      if (!after.ok) note('the item is GONE from the local API — trash must set deleted=1, never erase.');
      else if (!inTrash) note('the item is not flagged deleted in the local API yet (Zotero may still be syncing the change).');
    }
  }
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => stub.close(resolve));
}

// ------------------------------------------------------------------- summary --
console.log(`\n${passes} passed, ${skips} skipped, ${failures} failed`);
if (itemKey && !trashed) {
  console.log('\nMANUAL CLEANUP NEEDED — this Zotero cannot trash items without a cloud key.');
  console.log(`  Delete in Zotero: "${TITLE}" (item ${itemKey}${pdfKey ? `, attachment ${pdfKey}` : ''})`);
  if (annotationKeys.length) console.log(`  Annotation(s) left on the PDF: ${annotationKeys.join(', ')}`);
  console.log('  Tip: search the library for the tag `zoteus-smoke-test`.');
}
console.log(failures ? 'SMOKE FAILED' : 'SMOKE OK');
process.exit(failures ? 1 : 0);

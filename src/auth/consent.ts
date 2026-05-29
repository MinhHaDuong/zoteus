/** HTML-escape a string for safe interpolation into element text or attributes. */
export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Sanitize an attacker-controlled display string (e.g. a DCR `client_name`):
 * strip ASCII/C1 control chars and Unicode bidi/format overrides that enable
 * spoofing, then truncate. HTML-escaping still happens in the template.
 */
export function sanitizeDisplay(s: string, max = 64): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const isBidiOrFormat =
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    if (isControl || isBidiOrFormat) continue;
    out += ch;
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export interface ConsentPageOptions {
  authId: string;
  clientName: string;
  /** Host of the redirect_uri the authorization code will be sent to (anti-phishing hint). */
  redirectHost: string;
  error?: string;
}

/** Minimal self-contained HTML consent/passcode page; posts to ./consent. */
export function renderConsentPage({ authId, clientName, redirectHost, error }: ConsentPageOptions): string {
  const name = esc(sanitizeDisplay(clientName));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect to Zoteus</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; } .muted { opacity: .7; font-size: .9rem; }
  code { background: #8881; padding: .05rem .3rem; border-radius: .25rem; }
  form { display: grid; gap: .75rem; margin-top: 1.5rem; }
  input[type=password] { padding: .6rem; font-size: 1rem; border: 1px solid #8888; border-radius: .4rem; }
  button { padding: .6rem; font-size: 1rem; border: 0; border-radius: .4rem; background: #6E56CF; color: #fff; cursor: pointer; }
  .err { color: #c0392b; font-size: .9rem; }
</style></head>
<body>
  <h1>Connect <strong>${name}</strong> to Zoteus</h1>
  <p class="muted">This client is requesting access to your Zotero library via Zoteus. The authorization code will be sent to <code>${esc(redirectHost)}</code>. Enter the server access passcode to authorize.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <form method="post" action="consent">
    <input type="hidden" name="auth_id" value="${esc(authId)}" />
    <input type="password" name="passcode" placeholder="Access passcode" autofocus required autocomplete="off" />
    <button type="submit">Authorize</button>
  </form>
</body></html>`;
}

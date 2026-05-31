import { esc, sanitizeDisplay } from './consent.js';

export interface LicensePageOptions {
  authId: string;
  clientName: string;
  /** Host of the redirect_uri the eventual code will be sent to (anti-phishing hint). */
  redirectHost: string;
  error?: string;
  /** Polar checkout URL shown as a Subscribe link when present. */
  checkoutUrl?: string;
}

/** Self-contained "paste your subscription key" page; posts to ./license. Mirrors consent.ts. */
export function renderLicensePage({ authId, clientName, redirectHost, error, checkoutUrl }: LicensePageOptions): string {
  const name = esc(sanitizeDisplay(clientName));
  const subscribe = checkoutUrl
    ? `<p class="muted">No subscription yet? <a href="${esc(checkoutUrl)}">Subscribe</a>, then paste the key you receive by email.</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Subscription — Zoteus</title>
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
  <p class="muted">This is the paid hosted Zoteus. Enter your subscription key to continue to the Zotero sign-in. The authorization code will be sent to <code>${esc(redirectHost)}</code>.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <form method="post" action="license">
    <input type="hidden" name="auth_id" value="${esc(authId)}" />
    <input type="password" name="license_key" placeholder="Subscription key" autofocus required autocomplete="off" />
    <button type="submit">Continue</button>
  </form>
  ${subscribe}
</body></html>`;
}

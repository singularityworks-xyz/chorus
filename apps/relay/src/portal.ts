import type { RelayConfig } from "./config";

const styles = Bun.file(new URL("./portal/style.css", import.meta.url)).text();

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Account/connection UI only. The workspace frontend is served by its host. */
export async function renderPortal(config: RelayConfig): Promise<Response> {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chorus connections</title><style nonce="${nonce}">${await styles}</style></head>
<body><main><a href="/">CHORUS / CONNECTIONS</a>
<h1>Your work runs on your machines.</h1>
<p>This server connects your browser to Chorus on your laptop or VPS. Repositories, agents, and workspace state stay on your host.</p>
<p id="status" role="status" aria-live="polite">Checking your account…</p>
<section id="sign-in" hidden><h2>Sign in to manage connections</h2>
<div class="cf-turnstile" data-sitekey="${html(config.turnstileSiteKey)}" data-action="relay-sign-in" data-callback="captchaReady"></div>
<button id="github" disabled>Continue with GitHub</button>
<button id="google" class="secondary" disabled>Continue with Google</button></section>
<section id="enrollment" hidden><h2>Connect this host?</h2><p id="host-name"></p>
<p>Only approve a request you started in Chorus on your own machine.</p>
<p>Host identity: <code id="host-id"></code></p>
<p>Compare this key fingerprint with the one on that machine: <code id="host-key"></code></p>
<button id="approve">Approve connection</button></section>
<section id="hosts" hidden><h2>Your hosts</h2><p>Enable remote access in Chorus on a machine to add it here.</p>
<div id="host-list"></div><button id="logout" class="secondary">Sign out</button></section>
<noscript>JavaScript is needed to sign in and approve a host connection.</noscript>
<dialog id="disconnect-dialog" aria-labelledby="disconnect-title"><h2 id="disconnect-title">Disconnect host?</h2>
<p>Its local workspace stays on the machine. Remote access will stop.</p>
<button id="disconnect-cancel" class="secondary">Cancel</button><button id="disconnect-confirm">Disconnect</button></dialog></main>
<script nonce="${nonce}" type="module" src="/assets/portal.js"></script>
<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; style-src 'nonce-${nonce}'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    }
  );
}

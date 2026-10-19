import type { BrowserContext } from 'playwright';
import { classifyRequest, isManagerURL, type Phase } from './policy';
import { AppError } from './errors';
import { isLoginHTML } from './extractor';
export interface Snapshot { url: string; html: string }
export async function installGuard(context: BrowserContext, onSnapshot: (snapshot: Snapshot) => void, onStop: (error: AppError) => void) {
  let phase: Phase = 'authentication';
  let violation: AppError | null = null;
  let redirectCount = 0;
  const halt = (message: string, code = 'SAFETY_STOP') => {
    if (violation) return;
    violation = new AppError(code, message);
    onStop(violation);
    // No unload handlers; keep the latch closed until the context has gone away.
    void context.close().catch(() => {});
  };
  await context.routeWebSocket('**/*', socket => { socket.close(); halt('A WebSocket connection was blocked. This transport is not permitted by the read-only policy.'); });
  await context.route('**/*', async route => {
    if (violation) { await route.abort().catch(() => {}); return; }
    const request = route.request();
    let frameUrl = '';
    try { frameUrl = request.frame().url(); } catch { /* No frame is not authentication. */ }
    const facts = { url: request.url(), method: request.method(), resourceType: request.resourceType(), navigation: request.isNavigationRequest(), frameUrl, contentType: request.headers()['content-type'], body: request.postData() };
    const decision = classifyRequest(facts, phase);
    if (decision.action !== 'allow') {
      await route.abort('blockedbyclient').catch(() => {});
      if (decision.action === 'stop') halt(`${decision.reason} Blocked ${request.method()} ${request.resourceType()} request. Reconnect only after the integration is reviewed if this repeats.`);
      return;
    }
    try {
      // Never continue an upstream request: browser redirects are not guaranteed to re-enter routing.
      // Fetch exactly one reviewed hop, then turn safe document redirects into fresh navigations.
      let response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
      let status = response.status();
      let resourceURL = request.url();
      let hops = 0;
      while (!request.isNavigationRequest() && status >= 300 && status < 400) {
        const location = response.headers()['location'];
        const nextURL = location ? new URL(location, resourceURL).href : null;
        if (request.method() !== 'GET' || !nextURL || ++hops > 5 || new URL(nextURL).origin !== new URL(resourceURL).origin || classifyRequest({ ...facts, url: nextURL }, phase).action !== 'allow') {
          await route.abort(); halt('An unreviewed resource redirect was blocked before following it.'); return;
        }
        resourceURL = nextURL;
        response = await route.fetch({ url: nextURL, maxRedirects: 0, maxRetries: 0, timeout: 30000 });
        status = response.status();
      }
      if (status >= 300 && status < 400) {
        const location = response.headers()['location'];
        if (!location || !request.isNavigationRequest() || ![301, 302, 303].includes(status) || ++redirectCount > 10) {
          await route.abort(); halt('An unsupported redirect was blocked before following it.'); return;
        }
        const nextURL = new URL(location, request.url()).href;
        const next = classifyRequest({ ...facts, url: nextURL, method: 'GET', body: null }, phase);
        if (next.action !== 'allow') { await route.abort();
          if (phase === 'discovery' && new URL(nextURL).origin === 'https://www.odoo.com' && /^\/web\/login(?:\/totp)?$/.test(new URL(nextURL).pathname)) halt('Your Odoo session expired. Use Reconnect to sign in again.', 'SESSION_EXPIRED');
          else halt('An unexpected redirect destination was blocked before following it.'); return; }
        const escaped = nextURL.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'Content-Security-Policy': "default-src 'none'; form-action 'none'; base-uri 'none'", 'Cache-Control': 'no-store' }, body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escaped}"><title>Continue to Odoo</title><p>Continuing to the reviewed Odoo page…</p>` });
        return;
      }
      redirectCount = 0;
      if (request.isNavigationRequest() && status >= 400) { await route.abort(); halt(status === 403 ? 'Odoo refused this connection. Complete normal authentication in a supported session; access restrictions cannot be bypassed.' : 'Odoo is unavailable or returned an error. Retry later.', status === 403 ? 'ACCESS_RESTRICTED' : 'MANAGER_UNAVAILABLE'); return; }
      if (isManagerURL(request.url()) && request.method() === 'GET') {
        if (status !== 200 || !(response.headers()['content-type'] ?? '').includes('text/html')) {
          await route.abort();
          halt(status === 403 ? 'Odoo denied access to the database manager.' : 'The database manager returned an unsupported response. No discovery data was accepted.');
          return;
        }
        const html = await response.text();
        if (isLoginHTML(html)) {
          if (phase !== 'authentication') { await route.abort(); halt('The session expired during discovery. Reconnect to authenticate.'); return; }
          await route.fulfill({ response }); return;
        }
        if (html.length > 12_000_000) { await route.abort(); halt('The manager response exceeds the reviewed size limit.'); return; }
        onSnapshot({ url: request.url(), html });
        phase = 'discovery';
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: {
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'", 'Cache-Control': 'no-store',
        }, body: '<!doctype html><html lang="en"><title>Odoo connected — read only</title><body style="font:17px system-ui;background:#f4f7f5;color:#193c34;padding:12vh 12vw"><h1>Odoo connected.</h1><p>The database list has been read safely. Return to Odoo Lifecycle Manager.</p><p>READ-ONLY MODE — No database changes are possible.</p><p>This snapshot contains no active database-management controls.</p></body></html>' });
        return;
      }
      await route.fulfill({ response });
    } catch (error) {
      const transport = error instanceof Error ? (error.message.match(/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ERR_[A-Z_]+|Timeout|timeout|socket hang up|Protocol error/)?.[0] ?? 'transport error') : 'transport error';
      await route.abort().catch(() => {});
      const origin = new URL(request.url());
      // Challenge code can intentionally probe a non-resolving host. Preserve the real
      // network failure; never synthesize successful challenge responses or close the form.
      if (!request.isNavigationRequest() && (origin.hostname === 'challenges.cloudflare.com' || /^[a-z0-9-]+\.challenges\.cloudflare\.com$/.test(origin.hostname))) return;
      if (!violation) halt(`The protected ${request.method()} ${request.resourceType()} request could not complete (${transport}). Check your connection and reconnect.`);
    }
  });
  context.on('page', page => {
    page.on('download', download => { void download.cancel(); halt('Downloads are disabled in this read-only discovery session.'); });
    page.on('dialog', dialog => { void dialog.dismiss(); });
  });
  return { assertSafe() { if (violation) throw violation; }, get violation() { return violation; }, setDiscovery() { phase = 'discovery'; } };
}

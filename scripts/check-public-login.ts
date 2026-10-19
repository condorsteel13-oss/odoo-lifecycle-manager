// Optional, explicit smoke check of the PUBLIC login page only. Never submits a form.
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { installGuard } from '../electron/guard';
import { classifyRequest, LOGIN_URL } from '../electron/policy';
const folder = readdirSync('browser-binaries').find(n => /^chromium-/.test(n))!;
const browser = await chromium.launch({ headless: false, executablePath: resolve('browser-binaries', folder, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US' });
  context.on('request', request => {
    const result = classifyRequest({ url: request.url(), method: request.method(), resourceType: request.resourceType(), navigation: request.isNavigationRequest(), frameUrl: request.frame().url(), body: request.postData(), contentType: request.headers()['content-type'] }, 'authentication');
    if (result.action === 'stop') { const u = new URL(request.url()); console.log('Public-page blocked route:', request.method(), u.origin, (['/web/webclient/bootstrap_translations', '/web/webclient/version_info', '/web/session/get_session_info'].includes(u.pathname) ? u.pathname : u.pathname.split('/').slice(0, 3).join('/') + '/[redacted]'), [...u.searchParams.keys()], request.resourceType()); }
  });
  const guard = await installGuard(context, () => { throw new Error('Unexpected authenticated page in fresh context'); }, error => console.log(error.code, error.message));
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  console.log('Public page title:', await page.title());
  console.log('Public login field count:', await page.locator('input[name="login"]').count());
  await page.screenshot({ path: join('test-results', 'public-login.png') });
  await page.locator('input[name="login"]').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(4000);
  guard.assertSafe();
  console.log('PUBLIC LOGIN FORM VERIFIED; no credentials entered or authentication submitted.');
  await page.screenshot({ path: join('test-results', 'public-login.png') });
} finally { await browser.close(); }

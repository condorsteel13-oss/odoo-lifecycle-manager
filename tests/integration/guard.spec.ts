import { test, expect, chromium, type Browser } from '@playwright/test';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installGuard, type Snapshot } from '../../electron/guard';
import { extractManager } from '../../electron/extractor';
import { MANAGER_URL } from '../../electron/policy';
let browser: Browser;
let server: ReturnType<typeof httpsServer>;
let proxy: ReturnType<typeof httpServer>;
let directory: string;
let received: string[] = [];
let loginHTML = '';
let managerHTML = readFileSync('tests/fixtures/manager.html', 'utf8');
const fixture = managerHTML;
const login = '<!doctype html><title>Mock login</title><form method="post" action="/web/login"><input name="csrf_token" value="mock" type="hidden"><input name="redirect" value="/my/databases" type="hidden"><input aria-label="Login" name="login"><input aria-label="Password" name="password" type="password"><button>Log in</button></form>';
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'odoo-guard-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=www.odoo.com'], { stdio: 'ignore' });
  server = httpsServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) }, (req, res) => {
    received.push(`${req.method} ${req.url}`);
    if (req.url === '/openerp_enterprise/exists') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: true })); return; }
    if (req.url === '/web/login' && req.method === 'POST') { res.writeHead(303, { location: '/my/databases', 'set-cookie': 'mock_session=local; Path=/; Secure; HttpOnly' }); res.end(); return; }
    if (req.url === '/web/assets/1/test/redirect.js') { res.writeHead(302, { location: '/web/assets/1/test/final.js' }); res.end(); return; }
    if (req.url === '/web/assets/1/test/unsafe.js') { res.writeHead(302, { location: '/my/databases/delete' }); res.end(); return; }
    if (req.url === '/web/assets/1/test/final.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('window.fixtureAssetLoaded = true;'); return; }
    if (req.url === '/my/databases?page=9') { res.writeHead(302, { location: '/my/databases/delete' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url?.startsWith('/my/databases') ? managerHTML : (loginHTML || login));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const serverPort = (server.address() as { port: number }).port;
  proxy = httpServer((_req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connect', (req, socket, head) => {
    // No possible egress: only this fake hostname is mapped to the local fixture server.
    if (req.url !== 'www.odoo.com:443') { socket.destroy(); return; }
    const target = connect(serverPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); socket.pipe(target); target.pipe(socket); });
    socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy()); socket.on('close', () => target.destroy());
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const folder = readdirSync('browser-binaries').find(n => /^chromium-/.test(n))!;
  browser = await chromium.launch({ executablePath: resolve('browser-binaries', folder, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), headless: true, proxy: { server: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` } });
});
test.afterAll(async () => { await browser?.close(); server?.closeAllConnections(); server?.close(); proxy?.closeAllConnections(); proxy?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
test.beforeEach(() => { received = []; managerHTML = fixture; loginHTML = login; });
test('manual authentication reaches the fixture; management HTML becomes inert', async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const snapshots: Snapshot[] = [];
  const errors: Error[] = [];
  await installGuard(context, s => snapshots.push(s), e => errors.push(e));
  const page = await context.newPage();
  managerHTML += '<script>fetch("/my/databases/delete",{method:"POST"})</script><button onclick="fetch(\'/my/databases/duplicate\', {method:\'POST\'})">Duplicate</button>';
  await page.goto('https://www.odoo.com/web/login');
  await page.getByLabel('Login').fill('fixture-user'); await page.getByLabel('Password').fill('fixture-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  expect(errors.map(e => e.message), JSON.stringify(received)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Odoo connected.' })).toBeVisible();
  expect(snapshots).toHaveLength(1); expect(extractManager(snapshots[0].html).databases).toHaveLength(5);
  expect(await page.locator('script, button, form, iframe').count()).toBe(0);
  expect(received).toContain('POST /web/login');
  expect((await context.cookies()).some(c => c.name === 'mock_session' && c.value === 'local')).toBe(true);
  expect(received.filter(r => /duplicate|delete/.test(r))).toEqual([]); expect(errors).toEqual([]);
  await context.close();
});
test('login field blur can check account existence without allowing extra RPC parameters', async () => {
  for (const extra of [false, true]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const guard = await installGuard(context, () => {}, () => {});
    const page = await context.newPage(); await page.goto('https://www.odoo.com/web/login');
    received = [];
    const result = await page.evaluate(extra => new Promise<number>(resolve => {
      const xhr = new XMLHttpRequest(); xhr.open('POST', '/openerp_enterprise/exists'); xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => resolve(xhr.status); xhr.onerror = () => resolve(0);
      xhr.send(JSON.stringify({ jsonrpc: '2.0', method: 'call', id: 1, params: { login: 'fixture@example.com', ...(extra ? { method: 'unlink' } : {}) } }));
    }), extra).catch(() => 0);
    if (extra) { await expect.poll(() => guard.violation !== null).toBe(true); expect(received).toEqual([]); }
    else { expect(result).toBe(200); expect(guard.violation).toBeNull(); await expect(page.getByLabel('Password')).toBeVisible(); expect(received).toEqual(['POST /openerp_enterprise/exists']); }
    await context.close().catch(() => {});
  }
});
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${method} mutation is aborted before reaching the server and closes the context`, async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  let stopped = false;
  const guard = await installGuard(context, () => {}, () => { stopped = true; });
  const page = await context.newPage(); await page.goto('https://www.odoo.com/web/login');
  const closed = context.waitForEvent('close');
  await page.evaluate(async verb => { await fetch('/my/databases/delete', { method: verb }).catch(() => {}); }, method).catch(() => {});
  await closed;
  expect(stopped).toBe(true); expect(() => guard.assertSafe()).toThrow(/allowlist|method/);
  expect(received.filter(r => /delete/.test(r))).toEqual([]);
});
test('GET mutation, query mutation and unexpected redirects are never forwarded', async () => {
  for (const target of ['/my/databases/delete', '/my/databases?delete=1', '/my/databases?page=9']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const guard = await installGuard(context, () => {}, () => {});
    const page = await context.newPage();
    await page.goto(`https://www.odoo.com${target}`).catch(() => {});
    await expect.poll(() => guard.violation !== null).toBe(true);
    expect(received.some(r => r.includes('/delete') || r.includes('?delete='))).toBe(false);
    await context.close().catch(() => {});
  }
});
test('expired session remains an authentication screen, never an empty successful discovery', async () => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  managerHTML = login;
  const snapshots: Snapshot[] = [];
  await installGuard(context, s => snapshots.push(s), () => {});
  const page = await context.newPage(); await page.goto(MANAGER_URL);
  expect(snapshots).toHaveLength(0); await expect(page.getByLabel('Password')).toBeVisible();
  await context.close();
});
test('WebSocket and unknown RPC requests fail closed', async () => {
  for (const kind of ['websocket', 'rpc']) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const guard = await installGuard(context, () => {}, () => {});
    const page = await context.newPage(); await page.goto('https://www.odoo.com/web/login');
    await page.evaluate(k => { if (k === 'websocket') new WebSocket('wss://www.odoo.com/websocket'); else void fetch('/web/dataset/call_kw', { method: 'POST', body: JSON.stringify({ model: 'odoo.database', method: 'unlink' }) }).catch(() => {}); }, kind).catch(() => {});
    await expect.poll(() => guard.violation !== null).toBe(true);
    expect(received.some(r => /websocket|call_kw/.test(r))).toBe(false);
    await context.close().catch(() => {});
  }
});

test('resource redirects are individually reviewed, including redirects toward a mutation', async () => {
  for (const safe of [true, false]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const guard = await installGuard(context, () => {}, () => {});
    loginHTML = `${login}<script src="/web/assets/1/test/${safe ? 'redirect' : 'unsafe'}.js"></script>`;
    const page = await context.newPage(); await page.goto('https://www.odoo.com/web/login').catch(() => {});
    if (safe) { expect(await page.evaluate(() => (window as any).fixtureAssetLoaded)).toBe(true); expect(guard.violation).toBeNull(); }
    else { await expect.poll(() => guard.violation !== null).toBe(true); expect(received.some(r => r.includes('/delete'))).toBe(false); }
    await context.close().catch(() => {});
  }
});

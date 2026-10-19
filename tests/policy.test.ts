import { describe, expect, it } from 'vitest';
import { classifyRequest, isManagerURL, MANAGER_URL, type RequestFacts } from '../electron/policy';
const facts = (path: string, overrides: Partial<RequestFacts> = {}): RequestFacts => ({ url: `https://www.odoo.com${path}`, method: 'GET', resourceType: 'document', navigation: true, frameUrl: 'https://www.odoo.com/web/login', ...overrides });
describe('closed request allowlist', () => {
  it('allows only unfiltered list pagination', () => {
    for (const url of [MANAGER_URL, `${MANAGER_URL}/page/2`, `${MANAGER_URL}?page=3`]) expect(isManagerURL(url)).toBe(true);
    for (const suffix of ['?delete=1', '?page=1&page=2', '?search=hidden', '/delete/1', '?redirect=/web/database/drop', '?page=-1', '#delete']) expect(isManagerURL(MANAGER_URL + suffix)).toBe(false);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('blocks every management %s', method => {
    for (const path of ['/my/databases', '/my/databases/duplicate', '/my/databases/delete', '/web/database/drop', '/web/database/duplicate', '/web/dataset/call_kw', '/web/dataset/call_button', '/json/2/odoo.database/list']) expect(classifyRequest(facts(path, { method }), 'authentication').action).toBe('stop');
  });
  it.each(['/my/databases?delete=1', '/my/databases/hide/1', '/my/databases/rename', '/web/database/create', '/my/databases/%64elete', '/my/databases/manage/42', '/web/action/run', '/trial'])('blocks mutation and unreviewed GET %s', path => expect(classifyRequest(facts(path), 'discovery').action).toBe('stop'));
  it('allows credentials only in the official manual login form', () => {
    const login = facts('/web/login', { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'csrf_token=test&login=demo&password=not-a-real-password&type=password&redirect=%2Fmy%2Fdatabases' });
    expect(classifyRequest(login, 'authentication').action).toBe('allow');
    expect(classifyRequest(login, 'discovery').action).toBe('stop');
    expect(classifyRequest({ ...login, frameUrl: 'https://evil.example' }, 'authentication').action).toBe('stop');
    for (const extra of ['&model=odoo.database', '&method=unlink', '&redirect=%2Fweb%2Fdatabase%2Fdrop', '&password=another']) expect(classifyRequest({ ...login, body: login.body + extra }, 'authentication').action).toBe('stop');
    expect(classifyRequest({ ...login, body: login.body!.replace('type=password', 'type=delete') }, 'authentication').action).toBe('stop');
  });
  it('permits normal TOTP without permitting account changes', () => {
    const totp = facts('/web/login/totp', { method: 'POST', contentType: 'application/x-www-form-urlencoded', frameUrl: 'https://www.odoo.com/web/login/totp', body: 'csrf_token=test&totp_token=123456&redirect=%2Fmy%2Fdatabases' });
    expect(classifyRequest(totp, 'authentication').action).toBe('allow');
    expect(classifyRequest({ ...totp, body: `${totp.body}&disable_2fa=true` }, 'authentication').action).toBe('stop');
  });
  it('rejects unknown RPC, external redirects, alternate Odoo hosts, and credentials in URLs', () => {
    for (const url of ['https://odoo.com/my/databases', 'https://mydb.odoo.com/web', 'http://www.odoo.com/my/databases', 'https://www.odoo.com.evil.test/my/databases', 'https://name:secret@www.odoo.com/my/databases']) expect(classifyRequest(facts('', { url }), 'authentication').action).toBe('stop');
    expect(classifyRequest(facts('/web/dataset/call_kw', { method: 'POST', body: '{"model":"odoo.database","method":"read"}' }), 'discovery').action).toBe('stop');
  });
  it('allows reviewed static assets but not action paths disguised as assets', () => {
    expect(classifyRequest(facts('/web/assets/1/abc123/web.assets_frontend.min.js', { resourceType: 'script', navigation: false }), 'authentication').action).toBe('allow');
    expect(classifyRequest(facts('/my/databases/delete.js', { resourceType: 'script', navigation: false }), 'authentication').action).toBe('stop');
  });
  it('allows challenge providers only during authentication', () => {
    const req = facts('', { url: 'https://www.recaptcha.net/recaptcha/api2/reload?k=public', method: 'POST', resourceType: 'xhr', navigation: false });
    expect(classifyRequest(req, 'authentication').action).toBe('allow');
    expect(classifyRequest(req, 'discovery').action).toBe('stop');
  });
});

it('public bootstrap exceptions remain GET-only with bounded parameters', () => {
  for (const path of ['/saas_worker/const.json', '/website/translations?lang=en_US&hash=abc123']) {
    const r = facts(path, { resourceType: 'fetch', navigation: false });
    expect(classifyRequest(r, 'authentication').action).toBe('allow');
    expect(classifyRequest({ ...r, method: 'POST' }, 'authentication').action).toBe('stop');
    expect(classifyRequest(r, 'discovery').action).toBe('stop');
  }
  expect(classifyRequest(facts('/website/translations?model=odoo.database&method=unlink', { resourceType: 'fetch', navigation: false }), 'authentication').action).toBe('stop');
});
it('accepts only the exact absolute manager redirect used by Odoo', () => {
  expect(classifyRequest(facts('/web/login?redirect=https%3A%2F%2Fwww.odoo.com%2Fmy%2Fdatabases'), 'authentication').action).toBe('allow');
  expect(classifyRequest(facts('/web/login?redirect=https%3A%2F%2Fevil.example%2Fmy%2Fdatabases'), 'authentication').action).toBe('stop');
});
it('public POST bootstrap cannot carry database or arbitrary RPC parameters', () => {
  for (const path of ['/web/webclient/bootstrap_translations', '/web/webclient/version_info']) {
    const r = facts(path, { method: 'POST', resourceType: 'xhr', navigation: false, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {}, id: 1 }) });
    expect(classifyRequest(r, 'authentication').action).toBe('allow');
    expect(classifyRequest(r, 'discovery').action).toBe('stop');
    for (const params of [{ model: 'odoo.database', method: 'unlink' }, { mods: ['base'] }, []]) expect(classifyRequest({ ...r, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: 1 }) }, 'authentication').action).toBe('stop');
  }
});
it('challenge host scope excludes lookalikes and nonstandard ports', () => {
  for (const origin of ['https://challenges.cloudflare.com.evil.test', 'https://evilcloudflare.com', 'https://probe.challenges.cloudflare.com:8443']) expect(classifyRequest(facts('', { url: `${origin}/cdn-cgi/challenge-platform/h/b/test`, resourceType: 'fetch', navigation: false }), 'authentication').action).toBe('stop');
});
it('allows only the official login existence check with a single account identifier', () => {
  const request = facts('/openerp_enterprise/exists', { method: 'POST', resourceType: 'xhr', navigation: false, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { login: 'test@example.com' }, id: 1 }) });
  expect(classifyRequest(request, 'authentication').action).toBe('allow');
  expect(classifyRequest(request, 'discovery').action).toBe('stop');
  for (const params of [{ login: 'test@example.com', method: 'unlink' }, { login: 'test@example.com', password: 'secret' }, { login: '' }, { login: 'a'.repeat(321) }, { login: ['test@example.com'] }, { login: 'a\nb' }, {}]) expect(classifyRequest({ ...request, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: 1 }) }, 'authentication').action).toBe('stop');
  for (const overrides of [{ method: 'GET' }, { navigation: true }, { frameUrl: MANAGER_URL }, { frameUrl: 'https://evil.example/web/login' }, { url: request.url + '?method=unlink' }, { url: request.url + '/delete' }]) expect(classifyRequest({ ...request, ...overrides }, 'authentication').action).toBe('stop');
});

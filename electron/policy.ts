// Closed allowlist. No environment variable or setting can widen this policy.
export const ODOO_ORIGIN = 'https://www.odoo.com';
export const MANAGER_URL = `${ODOO_ORIGIN}/my/databases`;
export const LOGIN_URL = `${ODOO_ORIGIN}/web/login?redirect=%2Fmy%2Fdatabases`;
export type Phase = 'authentication' | 'discovery';
export interface RequestFacts { url: string; method: string; resourceType: string; navigation: boolean; frameUrl: string; contentType?: string; body?: string | null }
export interface Decision { action: 'allow' | 'omit' | 'stop'; reason: string }
const allow = (reason: string): Decision => ({ action: 'allow', reason });
const stop = (reason: string): Decision => ({ action: 'stop', reason });
const assetTypes = new Set(['script', 'stylesheet', 'image', 'font', 'media']);
const authPaths = new Set(['/web/login', '/web/login/totp']);
export function isManagerURL(input: string): boolean {
  try {
    const u = new URL(input);
    if (u.origin !== ODOO_ORIGIN || u.username || u.password || u.hash || /%|\\|\/\//.test(u.pathname)) return false;
    if (!/^\/my\/databases(?:\/page\/[1-9]\d*)?\/?$/.test(u.pathname)) return false;
    const keys = [...u.searchParams.keys()];
    return keys.length === new Set(keys).size && keys.every(k => k === 'page') && (!u.searchParams.has('page') || /^[1-9]\d{0,4}$/.test(u.searchParams.get('page')!));
  } catch { return false; }
}
function assetQuery(u: URL): boolean { return [...u.searchParams.entries()].every(([k,v]) => ['unique', 'v', 'width', 'height', 'crop', 'quality'].includes(k) && /^[a-zA-Z0-9_.-]{0,150}$/.test(v)); }
function managerRedirect(value: string | null): boolean { return value === '/my/databases' || value === MANAGER_URL; }
function authQuery(u: URL): boolean {
  const keys = [...u.searchParams.keys()];
  return keys.length === new Set(keys).size && keys.every(k => k === 'redirect') && (!u.searchParams.has('redirect') || managerRedirect(u.searchParams.get('redirect')));
}
function publicBootstrap(r: RequestFacts): boolean {
  if (!r.contentType?.startsWith('application/json') || !r.body || r.body.length > 1024) return false;
  try {
    const body = JSON.parse(r.body);
    return body && !Array.isArray(body) && Object.keys(body).every(k => ['jsonrpc', 'method', 'params', 'id'].includes(k)) && body.jsonrpc === '2.0' && body.method === 'call' && Number.isSafeInteger(body.id) && body.params && !Array.isArray(body.params) && Object.keys(body.params).length === 0;
  } catch { return false; }
}
function loginExistenceCheck(r: RequestFacts): boolean {
  if (!r.contentType?.startsWith('application/json') || !r.body || r.body.length > 2048) return false;
  try {
    const frame = new URL(r.frameUrl);
    if (frame.origin !== ODOO_ORIGIN || frame.pathname !== '/web/login' || !authQuery(frame)) return false;
    const body = JSON.parse(r.body);
    return body && !Array.isArray(body) && Object.keys(body).every(k => ['jsonrpc', 'method', 'params', 'id'].includes(k)) && body.jsonrpc === '2.0' && body.method === 'call' && Number.isSafeInteger(body.id) && body.params && !Array.isArray(body.params) && Object.keys(body.params).length === 1 && typeof body.params.login === 'string' && body.params.login.length > 0 && body.params.login.length <= 320 && !/[\u0000-\u001f\u007f]/.test(body.params.login);
  } catch { return false; }
}
function safeLoginBody(r: RequestFacts, path: string): boolean {
  if (!r.contentType?.startsWith('application/x-www-form-urlencoded') || !r.body || r.body.length > 24000) return false;
  const p = new URLSearchParams(r.body);
  const allowed = path === '/web/login' ? ['csrf_token', 'login', 'password', 'type', 'redirect', 'recaptcha_token_response', 'turnstile_captcha', 'g-recaptcha-response', 'cf-turnstile-response'] : ['csrf_token', 'totp_token', 'remember', 'redirect'];
  const keys = [...p.keys()];
  if (keys.length !== new Set(keys).size || keys.some(k => !allowed.includes(k))) return false;
  if (p.has('redirect') && !managerRedirect(p.get('redirect'))) return false;
  if (p.has('type') && p.get('type') !== 'password') return false;
  if (p.has('remember') && !['on', '1', 'true'].includes(p.get('remember')!)) return false;
  if (!p.get('csrf_token')) return false;
  return path === '/web/login' ? !!p.get('login') && !!p.get('password') : /^\s*\d[\d\s]{4,12}$/.test(p.get('totp_token') ?? '');
}
export function classifyRequest(r: RequestFacts, phase: Phase): Decision {
  let u: URL;
  try { u = new URL(r.url); } catch { return stop('Invalid request URL.'); }
  if (u.protocol !== 'https:' || u.username || u.password || /%|\\|\/\//.test(u.pathname)) return stop('Unreviewed origin or encoded path.');
  const method = r.method.toUpperCase();
  if (!['GET', 'POST'].includes(method)) return stop('HTTP method is not permitted.');
  if (method === 'GET' && ['https://odoocdn.com', ODOO_ORIGIN].includes(u.origin) && /^\/web\/image\/website\/\d+\/favicon$/.test(u.pathname) && !r.navigation && ['image', 'other'].includes(r.resourceType)) return { action: 'omit', reason: 'Optional website favicon omitted.' };
  if (u.origin === ODOO_ORIGIN) {
    if (method === 'GET' && u.pathname === '/favicon.ico' && !u.search && r.resourceType === 'image') return { action: 'omit', reason: 'Optional favicon omitted.' };
    if (method === 'GET' && isManagerURL(u.href) && r.navigation) return allow('Database list document.');
    if (phase === 'authentication' && method === 'GET' && !r.navigation && r.resourceType === 'fetch' && u.pathname === '/saas_worker/const.json' && !u.search) return allow('Reviewed public website constants.');
    if (phase === 'authentication' && method === 'GET' && !r.navigation && r.resourceType === 'fetch' && u.pathname === '/website/translations' && [...u.searchParams.entries()].every(([k,v]) => (k === 'lang' && /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(v)) || (k === 'hash' && /^[a-f0-9]{0,64}$/.test(v)))) return allow('Reviewed public interface translations.');
    if (phase === 'authentication' && method === 'POST' && !r.navigation && r.resourceType === 'xhr' && ['/web/webclient/bootstrap_translations', '/web/webclient/version_info'].includes(u.pathname) && !u.search && publicBootstrap(r)) return allow('Reviewed public language/version bootstrap with empty parameters.');
    // Official login UI checks whether the entered account exists when its field loses focus.
    // This is a fixed authentication endpoint, never a general RPC or database operation.
    if (phase === 'authentication' && method === 'POST' && !r.navigation && r.resourceType === 'xhr' && u.pathname === '/openerp_enterprise/exists' && !u.search && loginExistenceCheck(r)) return allow('Official login account-existence check.');
    if (phase === 'authentication' && authPaths.has(u.pathname) && authQuery(u) && r.navigation) {
      if (method === 'GET') return allow('Official authentication form.');
      let frame: URL;
      try { frame = new URL(r.frameUrl); } catch { return stop('Authentication requires the official form.'); }
      if (frame.origin === ODOO_ORIGIN && (authPaths.has(frame.pathname) || isManagerURL(frame.href)) && safeLoginBody(r, u.pathname)) return allow('Authentication form submission only.');
      return stop('Authentication request is outside the permitted form fields.');
    }
    // Optional telemetry is deliberately omitted, never forwarded or used for discovery.
    if (/^\/(?:website\/visitor|website\/tracking|im_livechat|mail\/|bus\/|social_push_notifications\/)/.test(u.pathname)) return { action: 'omit', reason: 'Optional telemetry or messaging is disabled.' };
  }
  if (method === 'GET' && !r.navigation && ((u.origin === 'https://fonts.googleapis.com' && ['\/css', '\/css2'].includes(u.pathname) && r.resourceType === 'stylesheet') || (u.origin === 'https://fonts.gstatic.com' && r.resourceType === 'font'))) return { action: 'omit', reason: 'Optional web fonts omitted.' };
  if (phase !== 'authentication') return stop('Only the database list document is permitted during discovery.');
  if (method === 'GET' && assetTypes.has(r.resourceType) && !r.navigation && [ODOO_ORIGIN, 'https://odoocdn.com'].includes(u.origin)) {
    if (/^\/web\/assets\/[A-Za-z0-9_./-]+\.(?:js|css|woff2?|ttf|svg|png|jpg)$/.test(u.pathname) && !u.search) return allow('Odoo static asset.');
    if (/^\/[a-zA-Z0-9_]+\/static\/[A-Za-z0-9_./@-]+\.(?:js|css|woff2?|ttf|svg|png|jpe?g|gif|webp|ico)$/.test(u.pathname) && assetQuery(u)) return allow('Odoo static resource.');
    if (/^\/web\/image\/website\/\d+\/(?:logo|favicon)(?:\/[^/]+)?$/.test(u.pathname) && [...u.searchParams.keys()].every(k => ['unique', 'width', 'height'].includes(k))) return allow('Website branding.');
  }
  // Challenges are rendered and completed normally. No solver or bypass exists.
  const captcha = (['https://www.recaptcha.net', 'https://www.google.com'].includes(u.origin) && /^\/recaptcha\/(?:api\.js|enterprise\.js|(?:api2|enterprise)\/(?:anchor|bframe|reload|userverify|payload|clr|pat))$/.test(u.pathname)) ||
    (u.origin === 'https://www.gstatic.com' && /^\/recaptcha\/releases\/[A-Za-z0-9_./-]+$/.test(u.pathname)) ||
    ((u.origin === 'https://challenges.cloudflare.com' || (!u.port && /^[a-z0-9-]+\.challenges\.cloudflare\.com$/.test(u.hostname))) && (/^\/turnstile\/v0(?:\/b\/[a-f0-9]{8,64})?\/api\.js$/.test(u.pathname) || /^\/cdn-cgi\/challenge-platform\/[A-Za-z0-9_:./-]+$/.test(u.pathname)));
  if (captcha && ['script', 'stylesheet', 'image', 'document', 'xhr', 'fetch'].includes(r.resourceType)) return allow('Authentication challenge provider.');
  if (['https://www.google-analytics.com', 'https://www.googletagmanager.com', 'https://connect.facebook.net'].includes(u.origin)) return { action: 'omit', reason: 'Optional analytics disabled.' };
  return stop('Request is absent from the read-only allowlist.');
}

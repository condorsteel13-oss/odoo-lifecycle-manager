import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractManager, isLoginHTML, parseExplicitDate } from '../electron/extractor';
const html = readFileSync('tests/fixtures/manager.html', 'utf8');
describe('read-only manager extraction', () => {
  it('extracts multiple databases and never calculates missing expiration', () => {
    const result = extractManager(html);
    expect(result.databases).toHaveLength(5);
    const first = result.databases[0];
    expect(first.name).toBe('atlas-staging'); expect(first.version).toBe('19.0');
    expect(first.expiresAt).toBe('2026-10-20'); expect(first.duplication).toBe('available');
    expect(result.databases[1].expiresAt).toBe('2026-11-18');
    expect(result.databases[1].subscription).toBe('linked');
    expect(result.databases[1].deletion).toBe('unavailable');
    expect(result.databases[3].expiresAt).toBeNull();
    expect(result.databases[4].duplication).toBe('unavailable');
  });
  it('rejects login/session expiry and missing permissions', () => {
    expect(isLoginHTML('<form><input name="password"></form>')).toBe(true);
    expect(() => extractManager('<form><input name="totp_token"></form>')).toThrow(/authentication/);
    expect(() => extractManager('<main><h1>Access denied</h1></main>')).toThrow(/denied/);
  });
  it('fails closed on interface changes rather than replacing data with an empty list', () => {
    expect(() => extractManager('<main>New frontend</main>')).toThrow(/not recognized/);
    expect(() => extractManager('<main><h1>My Databases</h1><div id="app"></div></main>')).toThrow(/No recognized/);
    expect(extractManager('<main><h1>My Databases</h1><p>You have no databases</p></main>').databases).toEqual([]);
  });
  it('reads only actual unfiltered pagination and rejects interactive paging', () => {
    expect(extractManager(html.replace('</main>', '<nav class="pagination"><a href="/my/databases/page/2">2</a></nav></main>')).pages).toEqual(['https://www.odoo.com/my/databases/page/2']);
    expect(() => extractManager(html.replace('</main>', '<div class="pagination"><a href="/my/databases?delete=1">Next</a></div></main>'))).toThrow(/pagination/);
    expect(() => extractManager(html.replace('</main>', '<button>Load more</button></main>'))).toThrow(/interactive pagination/);
  });
  it('does not log, serialize, or preserve secrets from HTML', () => {
    const result = JSON.stringify(extractManager(html.replace('</main>', '<input name="csrf_token" value="SECRET_TOKEN"><script>const secret="SECRET_TOKEN";</script><p>SECRET_TOKEN</p></main>')));
    expect(result).not.toContain('SECRET_TOKEN');
  });
  it('rejects identity conflicts and leaves conflicting dates unknown', () => {
    expect(() => extractManager(html.replace('href="https://atlas-staging.odoo.com"', 'href="https://some-other-db.odoo.com"'))).toThrow(/conflicts/);
    const conflict = extractManager(html.replace('data-expiration-date="2026-10-20"', 'data-expiration-date="2026-10-20" data-expiration="2026-10-21"'));
    expect(conflict.databases[0].expiresAt).toBeNull();
  });
  it('rejects ambiguous, relative, timezone-less and invalid dates', () => {
    for (const value of ['10/11/2026', 'in 3 days', '2026-02-30', 'February 30, 2026', '2026-02-30T12:00:00Z', '2026-10-22 10:00:00', 'Unknown']) expect(parseExplicitDate(value)).toBeNull();
  });
});

it('discovers explicitly labelled table rows even when the URL is unavailable', () => {
  const result = extractManager('<main><h1>My Databases</h1><table><thead><tr><th>Database</th><th>Expiration</th><th>Version</th></tr></thead><tbody><tr><td>no-url-visible</td><td>2026-10-22</td><td>19.0</td></tr></tbody></table></main>');
  expect(result.databases).toHaveLength(1);
  expect(result.databases[0]).toMatchObject({ name: 'no-url-visible', url: null, expiresAt: '2026-10-22', version: '19.0' });
});

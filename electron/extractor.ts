import { load } from 'cheerio';
import type { Database } from '../src/shared/types';
import { validDate } from '../src/domain/dates';
import { AppError } from './errors';
import { isManagerURL, MANAGER_URL } from './policy';
export interface ExtractedPage { databases: Database[]; pages: string[]; warnings: string[]; empty: boolean }
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
export function isLoginHTML(html: string): boolean {
  const $ = load(html);
  return $('form input[name="password"], form input[name="totp_token"]').length > 0;
}
export function parseExplicitDate(input: string | undefined): string | null {
  if (!input) return null;
  const value = input.trim();
  if (validDate(value)) return value;
  // Unambiguous English month names only; locale-ambiguous numeric dates stay Unknown.
  if (!/^(?:\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})$/.test(value)) return null;
  const tokens = value.replace(',', '').split(/\s+/);
  const dayFirst = /^\d+$/.test(tokens[0]);
  const day = Number(tokens[dayFirst ? 0 : 1]);
  const monthName = tokens[dayFirst ? 1 : 0].toLowerCase();
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const month = months.findIndex(m => monthName === m || monthName === m.slice(0, 3)) + 1;
  const normalized = `${tokens[2]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return month && validDate(normalized) ? normalized : null;
}
export function extractManager(html: string, pageURL = MANAGER_URL, now = new Date()): ExtractedPage {
  if (!isManagerURL(pageURL)) throw new AppError('UNEXPECTED_REDIRECT', 'The browser left the reviewed database-list route. Discovery stopped.');
  if (isLoginHTML(html)) throw new AppError('SESSION_EXPIRED', 'Odoo requires authentication. Use Connect to Odoo and finish login or two-factor verification.');
  const $ = load(html);
  if (/access denied|not authorized|permission denied/i.test($('main').text())) throw new AppError('MISSING_PERMISSION', 'Odoo denied access to the database manager. Sign in with an authorized administrator.');
  $('script, style, header, footer').remove();
  $('nav').not('.pagination, .o_portal_pager').filter((_, n) => $(n).find('.pagination, .o_portal_pager, a[rel="next"]').length === 0).remove();
  const main = $('main').length ? $('main') : $('body');
  const marker = main.find('h1,h2,h3').toArray().some(n => /^(?:my )?databases$/i.test($(n).text().trim())) || main.find('#database_manager, #database_list, .o_database_manager, .o_database_list, [data-database-list]').length > 0;
  if (!marker) throw new AppError('INTERFACE_CHANGED', 'The database manager structure was not recognized. No data was replaced. A reviewed adapter is required; see the research notes.');
  const databases: Database[] = [];
  const warnings: string[] = [];
  const candidates = new Set<any>();
  main.find('table').each((_, table) => {
    const headers = $(table).find('thead th').toArray().map(n => $(n).text().trim().toLowerCase());
    if (headers.some(h => ['database', 'database name'].includes(h))) $(table).find('tbody > tr').each((_, row) => { candidates.add(row); });
  });
  main.find('[data-db-name], [data-database-name], .o_database_card, .o_database, .o_database_row').each((_, n) => { candidates.add(n); });
  main.find('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href')!, pageURL);
      if (/^[a-z0-9-]+\.odoo\.com$/.test(u.hostname) && !['www.odoo.com', 'accounts.odoo.com', 'demo.odoo.com'].includes(u.hostname)) {
        const row = $(a).closest('tr, .card, .list-group-item, [data-db-name], [data-database-name], .o_database');
        if (row.length) candidates.add(row.get(0));
      }
    } catch { /* Invalid link is never followed. */ }
  });
  for (const node of candidates) {
    const row = $(node);
    if (row.find('[data-db-name], [data-database-name], .o_database_card, .o_database_row').length) continue;
    const text = row.text().replace(/\s+/g, ' ').trim();
    const lines = row.html()?.replace(/<\/(?:div|p|li|tr|dd|dt)>|<br\s*\/?\s*>/gi, '\n') ?? '';
    const lineText = load(`<body>${lines}</body>`)('body').text();
    const fields = new Map<string, string>();
    row.find('tr').each((_, n) => { const cells = $(n).find('th,td'); if (cells.length === 2) fields.set(cells.first().text().trim().toLowerCase().replace(/:$/, ''), cells.last().text().trim()); });
    row.find('dt').each((_, n) => { fields.set($(n).text().trim().toLowerCase().replace(/:$/, ''), $(n).next('dd').text().trim()); });
    // Table rows with labelled columns.
    const headers = row.closest('table').find('thead th').toArray().map(n => $(n).text().trim().toLowerCase());
    row.children('td').each((i, n) => { if (headers[i]) fields.set(headers[i], $(n).text().trim()); });
    function field(labels: string[]): string | undefined {
      for (const l of labels) {
        if (fields.has(l)) return fields.get(l);
        const match = lineText.match(new RegExp(`(?:^|\\n)\\s*${l}\\s*:\\s*([^\\n]+)`, 'i'));
        if (match) return match[1].trim();
      }
    }
    const urls: string[] = [];
    row.find('a[href]').each((_, n) => {
      try {
        const u = new URL($(n).attr('href')!, pageURL);
        if (u.protocol === 'https:' && !u.username && !u.password && /^[a-z0-9-]+\.odoo\.com$/.test(u.hostname) && !['www', 'demo', 'accounts', 'runbot', 'upgrade'].includes(u.hostname.split('.')[0])) urls.push(u.origin);
      } catch { /* ignored */ }
    });
    const origins = [...new Set(urls)];
    if (origins.length > 1) throw new AppError('AMBIGUOUS_DATABASE', 'A database card contains multiple database identities. Discovery stopped rather than merging them.');
    const url = origins[0] ?? null;
    const name = row.attr('data-db-name') ?? row.attr('data-database-name') ?? field(['database name', 'database', 'name']) ?? (url ? new URL(url).hostname.split('.')[0] : null);
    if (!name || !NAME.test(name)) throw new AppError('INTERFACE_CHANGED', 'A database row has no unambiguous database name. Discovery stopped.');
    if (url && name.toLowerCase() !== new URL(url).hostname.split('.')[0]) throw new AppError('AMBIGUOUS_DATABASE', 'The displayed database name conflicts with its URL. Discovery stopped.');
    const expiryValues = [row.attr('data-expiration-date'), row.attr('data-expiration'), field(['expiration date', 'expiration', 'expires on', 'expires']), row.find('[data-field="expiration_date"] time[datetime], time[data-field="expiration_date"]').attr('datetime')].filter((v): v is string => !!v);
    const dates = [...new Set(expiryValues.map(parseExplicitDate).filter((v): v is string => !!v))];
    const expiresAt = dates.length === 1 ? dates[0] : null;
    if (dates.length > 1) warnings.push(`Conflicting expiration values for ${name}; displayed as Unknown.`);
    const statusText = (row.attr('data-status') ?? field(['status']) ?? '').toLowerCase();
    const designationText = (row.attr('data-designation') ?? field(['type', 'designation', 'environment']) ?? '').toLowerCase();
    const subscriptionText = (row.attr('data-subscription') ?? field(['subscription', 'subscription status']) ?? '').toLowerCase();
    function availability(action: string): Database['duplication'] {
      let result: Database['duplication'] = 'unknown';
      row.find('button,a,[role="button"]').each((_, n) => {
        const control = $(n); const label = control.text().trim().toLowerCase();
        if (label !== action) return;
        const disabled = control.is('[disabled], [aria-disabled="true"], .disabled') || control.closest('[hidden], [aria-hidden="true"], .d-none').length > 0;
        const next = disabled ? 'unavailable' : 'available';
        if (result === 'unknown' || next === 'unavailable') result = next;
      });
      return result;
    }
    const restrictions: string[] = [];
    if (/duplicate.{0,25}limit.{0,15}(reached|exceeded)|maximum.{0,15}duplicates/i.test(text)) restrictions.push('The interface indicates a duplication limit or quota restriction.');
    if (/cannot (?:be )?duplicat|duplication (?:is )?(?:unavailable|disabled)/i.test(text)) restrictions.push('The interface indicates duplication is unavailable.');
    if (/cannot (?:be )?delet|deletion (?:is )?(?:unavailable|disabled)/i.test(text)) restrictions.push('The interface indicates deletion is unavailable.');
    const rawVersion = row.attr('data-version') ?? field(['odoo version', 'version']);
    const version = rawVersion?.match(/^(?:Odoo\s+)?(\d{1,2}\.\d+(?:[.+~a-z0-9-]*)?)$/i)?.[1] ?? null;
    const db: Database = {
      id: url ?? `odoo:${name.toLowerCase()}`, name, url, version,
      createdAt: parseExplicitDate(row.attr('data-create-date') ?? field(['creation date', 'created on', 'created'])), expiresAt,
      expirationEvidence: expiresAt ? 'Explicit expiration field in the authenticated database list' : null,
      status: ['active', 'trial', 'expired', 'suspended'].includes(statusText) ? statusText as Database['status'] : 'unknown',
      designation: /^(production|testing)$/.test(designationText) ? designationText as Database['designation'] : 'unknown',
      subscription: /^(linked|active|paid)$/.test(subscriptionText) ? 'linked' : /^(none|no subscription)$/.test(subscriptionText) ? 'none' : 'unknown',
      duplication: restrictions.some(r => /duplication/.test(r)) ? 'unavailable' : availability('duplicate'),
      deletion: restrictions.some(r => /deletion/.test(r)) ? 'unavailable' : availability('delete'),
      restrictions, observedAt: now.toISOString(), source: 'odoo',
    };
    const prior = databases.find(d => d.id === db.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(db)) throw new AppError('AMBIGUOUS_DATABASE', 'Conflicting cards describe the same database. Discovery stopped.');
    if (!prior) databases.push(db);
  }
  const empty = /(?:you (?:do not|don't) have any databases|no databases (?:found|available)|you have no databases)/i.test(main.text());
  if (!databases.length && !empty) throw new AppError('INTERFACE_CHANGED', 'No recognized database rows or explicit empty-list message were found. The manager may require a new adapter.');
  const pages = new Set<string>();
  main.find('.pagination a[href], .o_portal_pager a[href], a[rel="next"]').each((_, n) => {
    const u = new URL($(n).attr('href')!, pageURL);
    if (!isManagerURL(u.href)) throw new AppError('UNSUPPORTED_PAGINATION', 'The list uses unreviewed pagination or filters. Discovery stopped to avoid reporting an incomplete list.');
    pages.add(u.href);
  });
  if (main.find('button').toArray().some(n => /load more|next page/i.test($(n).text()) && !$(n).is('[disabled]'))) throw new AppError('UNSUPPORTED_PAGINATION', 'The list requires interactive pagination. A reviewed adapter is required.');
  if (databases.some(d => d.expiresAt === null)) warnings.push('Some expiration dates are not exposed unambiguously. No private RPC or database application was queried.');
  return { databases, pages: [...pages], warnings, empty };
}

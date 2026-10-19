import type { Database } from '../src/shared/types';
import { AppError } from './errors';
import { parseExplicitDate } from './extractor';
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface ListedDatabase { database: Database; uuid: string; parentUuid: string | null }
export function databaseOrigin(input: unknown, name?: string): string | null {
  if (typeof input !== 'string') return null;
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || !/^[a-z0-9][a-z0-9-]*\.odoo\.com$/.test(u.hostname) || ['www', 'accounts', 'demo', 'runbot', 'upgrade'].includes(u.hostname.split('.')[0])) return null;
    if (name && u.hostname.split('.')[0] !== name.toLowerCase()) return null;
    return u.origin;
  } catch { return null; }
}
export function unwrapRPC(input: unknown): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INTERFACE_CHANGED', 'Odoo returned an unsupported metadata response.');
  const envelope = input as Record<string, any>;
  if (envelope.error) {
    if(envelope.error.code===100 || envelope.error.data?.name==='odoo.http.SessionExpiredException') throw new AppError('SESSION_EXPIRED','Odoo requires an authenticated session for this read. Sign in in Chrome and try again.');
    throw new AppError('METADATA_UNAVAILABLE','Odoo returned an error for this metadata read.');
  }
  if (envelope.jsonrpc !== '2.0' || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new AppError('INTERFACE_CHANGED', 'Odoo returned an unsupported metadata response.');
  return envelope.result;
}
function version(input: unknown): string | null { return typeof input === 'string' && /^(?:saas[~ -])?\d{1,2}\.\d+(?:[.+~a-z0-9-]*)?$/i.test(input) ? input : null; }
export function explicitExpiration(record: Record<string, any>): string | null {
  const values = ['expiration_date', 'date_expiration', 'expiration', 'edu_expire_date'].map(key => parseExplicitDate(typeof record[key] === 'string' ? record[key] : undefined)).filter((v): v is string => !!v);
  const unique = [...new Set(values)]; return unique.length === 1 ? unique[0] : null;
}
export function parseDatabaseList(input: unknown, now = new Date()): ListedDatabase[] {
  const result = unwrapRPC(input);
  if (!Array.isArray(result.databases) || result.databases.length > 10000) throw new AppError('INTERFACE_CHANGED', 'The database list response is incomplete or unsupported.');
  const ids = new Set<string>(); const names = new Set<string>();
  return result.databases.map((row: any) => {
    if (!row || typeof row !== 'object' || typeof row.db_name !== 'string' || !NAME.test(row.db_name) || typeof row.uuid !== 'string' || !UUID.test(row.uuid) || ids.has(row.uuid) || names.has(row.db_name.toLowerCase())) throw new AppError('AMBIGUOUS_DATABASE', 'The database list contains a missing, repeated, or conflicting identity.');
    ids.add(row.uuid); names.add(row.db_name.toLowerCase());
    const url = databaseOrigin(row.url, row.db_name);
    if (!url) throw new AppError('AMBIGUOUS_DATABASE', 'A database URL does not match its name or the supported Odoo Online domain.');
    const expiresAt = explicitExpiration(row);
    const database: Database = { uuid:row.uuid, id: url, name: row.db_name, url, version: version(row.version), createdAt: parseExplicitDate(typeof row.create_date === 'string' ? row.create_date : undefined), expiresAt,
      expirationEvidence: expiresAt ? 'Explicit expiration field returned by the authenticated Odoo database list' : null,
      status: row.is_trial === true ? 'trial' : row.is_paid === true ? 'active' : 'unknown',
      designation: row.is_neutralized === true ? 'testing' : 'unknown', subscription: row.has_sub === true || row.is_paid === true ? 'linked' : row.has_sub === false ? 'none' : 'unknown',
      duplication: typeof row.btns?.duplicate === 'boolean' ? row.btns.duplicate ? 'available' : 'unavailable' : 'unknown',
      deletion: typeof row.btns?.delete === 'boolean' ? row.btns.delete ? 'available' : 'unavailable' : 'unknown',
      restrictions: [], observedAt: now.toISOString(), source: 'odoo' };
    return { database, uuid: row.uuid, parentUuid: typeof row.parent_uuid === 'string' && UUID.test(row.parent_uuid) ? row.parent_uuid : null };
  });
}
export function requireDatabaseSession(database: Database, input: unknown) {
  const result=unwrapRPC(input);
  if(!Number.isSafeInteger(result.uid)||result.uid<=0||result.db!==database.name) throw new AppError('SESSION_EXPIRED','The database session is missing or does not match this database.');
  return result;
}
export function applySessionExpiration(database: Database, input: unknown): Database {
  const result=requireDatabaseSession(database,input);
  // Odoo Python datetime serialization is UTC by contract, unlike arbitrary UI strings.
  const raw = result.expiration_date;
  const normalized = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw;
  const expiresAt = parseExplicitDate(typeof normalized === 'string' ? normalized : undefined);
  if (!expiresAt) return database;
  if (database.expiresAt && database.expiresAt !== expiresAt) return { ...database, expiresAt: null, expirationEvidence: null, restrictions: [...database.restrictions, 'Expiration sources disagree. Verify the date in Odoo.'] };
  return { ...database, expiresAt, expirationEvidence: 'Explicit expiration_date from the authenticated, read-only Odoo session-information endpoint (Odoo datetime: UTC)' };
}

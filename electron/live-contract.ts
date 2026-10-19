import { load } from 'cheerio';
import type { Database } from '../src/shared/types';
import { isProtected, validCopyName } from '../src/shared/live';
import { AppError } from './errors';
import { parseManagePage, validateTarget } from './manage';

// Main-process only. Never persist or send this object to the renderer.
export interface LiveInspection {
  database: Database; uuid: string; parentUuid: string | null;
  neutralized: boolean; token: string; accessToken: string | false;
  subId: number | false; isPaid: boolean; plan: string;
}
export function assertUnprotected(name: string) {
  if (isProtected(name)) throw new AppError('PROTECTED_DATABASE', 'The accounting database is excluded from all lifecycle actions.');
}
export function assertCopyName(name: string, original: string) {
  if (!validCopyName(name) || name === original || (name.startsWith('edu-') && !original.startsWith('edu-'))) throw new AppError('INVALID_COPY_NAME', 'Use a different name of 4–50 lowercase letters, digits or hyphens. Do not add the edu- prefix.');
}
export function parseLiveInspection(database: Database, uuid: string, parentUuid: string | null, html: string): LiveInspection {
  assertUnprotected(database.name); assertUnprotected(database.id);
  validateTarget(database.url!, uuid, database.name);
  const parsed = parseManagePage(database, html, new Date(), uuid);
  const $ = load(html); const nodes = $('owl-component[name="openerp_enterprise.MyDatabaseInfo"]');
  let props: any;
  try { if (nodes.length !== 1) throw 0; props = JSON.parse(nodes.attr('props') ?? ''); } catch { throw new AppError('LIVE_UNAVAILABLE', 'The Manage page cannot be safely used for live actions.'); }
  const info = props.subinfo, db = props.upgrade_info?.db;
  const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._~+\/=-]{1,16384}$/.test(v);
  if (!info || !db || db.db_name !== database.name || db.uuid !== uuid || db.is_admin !== true || db.upgradeQueued || info.is_custom_domain || info.scheme !== 'https' || info.saas_url !== 'odoo.com' || typeof info.sub_plan !== 'string' || !info.sub_plan || info.sub_plan === 'InProgress' || !token(info.token) || !(info.access_token === false || token(info.access_token)) || !(info.sub_id === false || Number.isSafeInteger(info.sub_id) && info.sub_id > 0)) {
    throw new AppError('LIVE_UNAVAILABLE', 'Odoo did not provide an eligible administrator Manage page. Check permissions, upgrades and subscription state in Odoo.');
  }
  const isPaid = !['Trial', 'OneAppFree', 'Edu'].includes(info.sub_plan);
  return { database: { ...parsed, subscription: info.sub_id || isPaid ? 'linked' : 'none', designation: info.is_neutralized === true ? 'testing' : parsed.designation }, uuid, parentUuid, neutralized: info.is_neutralized === true, token: info.token, accessToken: info.access_token, subId: info.sub_id, isPaid, plan: info.sub_plan };
}
export function identityFingerprint(value: LiveInspection) {
  return JSON.stringify([value.uuid, value.database.id, value.database.name, value.subId, value.isPaid, value.plan]);
}

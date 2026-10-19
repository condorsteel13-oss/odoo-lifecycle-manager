import { AppError } from './errors';
import { unwrapRPC } from './metadata';
import { parseExplicitDate } from './extractor';

export interface ActivationInfo { pending: boolean; activated: boolean; userEmail: string; recipientEmail: string | null; expiresAt?: string }
export function emailAddress(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value.trim()) ? value.trim() : null;
}
export function sameEmail(a: string | null, b: string | null) { return !!a && !!b && a.toLowerCase() === b.toLowerCase(); }
export function parseActivation(input: unknown): ActivationInfo {
  const info = unwrapRPC(input), userEmail = emailAddress(info.user_email);
  if (!userEmail || typeof info.status !== 'string' || !info.status) throw new AppError('ACTIVATION_UNAVAILABLE', 'Odoo did not identify the signed-in user’s email and activation status. No email was sent.');
  const expiresAt=typeof info.expiry_oe==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(info.expiry_oe)?parseExplicitDate(info.expiry_oe.replace(' ','T')+'Z'):null;
  return { ...(expiresAt?{expiresAt}:{}), pending: info.status === 'to_activate', activated: info.status === 'activated', userEmail, recipientEmail: emailAddress(info.activation_email) };
}
export function activationURL(link: string, copyName: string, expectedEmail: string): URL {
  let u: URL;try{u=new URL(link);}catch{throw new AppError('ACTIVATION_LINK_UNSUPPORTED','The activation link is invalid.');}
  // Observed official email route. Bind both address fields and database name;
  // no extra parameters, redirects, signup routes or foreign origins are accepted.
  const parts=u.pathname.split('/'), keys=[...u.searchParams.keys()].sort();
  if(u.origin!=='https://www.odoo.com'||u.username||u.password||u.port||u.hash
    ||parts.length!==5||parts[1]!=='odoo-enterprise'||parts[2]!=='confirm-database'||parts[3]!==copyName
    ||!/^[-A-Za-z0-9._~+%=]{32,1024}$/.test(parts[4])
    ||JSON.stringify(keys)!==JSON.stringify(['country_id','email','username'])
    ||!sameEmail(u.searchParams.get('email'),expectedEmail)||!sameEmail(u.searchParams.get('username'),expectedEmail)
    ||!/^\d{1,4}$/.test(u.searchParams.get('country_id')??''))throw new AppError('ACTIVATION_LINK_UNSUPPORTED','The email activation link does not match the tracked copy, signed-in user and supported Odoo route. No link was opened.');
  return u;
}

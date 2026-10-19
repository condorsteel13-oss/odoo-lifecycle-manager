import { load } from 'cheerio';
import { AppError } from './errors';
import { databaseOrigin } from './metadata';
import { parseExplicitDate } from './extractor';
import type { Database } from '../src/shared/types';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function validateTarget(origin:string,uuid:string,name:string) {
 if(databaseOrigin(origin,name)!==origin || !UUID.test(uuid)) throw new AppError('SAFETY_STOP','An unsupported database identity was rejected.');
}
export function oeaTarget(input:string,origin:string,name:string,requireToken=true):string|null {
 try {
  const url=new URL(input,origin);
  const allowed=['db','access_token','redirect'];
  if(url.origin!==origin || url.pathname!=='/auth_oauth/oea' || url.username || url.password || url.hash || [...url.searchParams.keys()].some(k=>!allowed.includes(k)) || allowed.some(k=>url.searchParams.getAll(k).length>1)) return null;
  if(url.searchParams.has('db') && url.searchParams.get('db')!==name) return null;
  if(url.searchParams.has('redirect') && url.searchParams.get('redirect')!=='/odoo/my-subscription') return null;
  if(requireToken && !url.searchParams.get('access_token')) return null;
  return url.href;
 } catch{return null;}
}
// This is Odoo's own Connect form. Never execute its surrounding HTML/scripts.
export function connectForm(html:string,origin:string,uuid:string,name:string):{url:string;body:string}|null {
 validateTarget(origin,uuid,name);
 const $=load(html);const forms=$('form');
 const accepted:{url:string;body:string}[]=[];
 forms.each((_,form)=>{
  const node=$(form);let url:URL;
  try{url=new URL(node.attr('action')??'',origin);}catch{return;}
  if(url.href!==origin+'/saas_trial/trial-connect' || node.attr('method')?.toUpperCase()!=='POST') return;
  const params=new URLSearchParams();let invalid=false;
  node.find('input').each((_,input)=>{
   const n=$(input);const key=n.attr('name');if(!key)return;
   if(!['db_uuid','token','redirect'].includes(key) || params.has(key) || n.attr('type')?.toLowerCase()!=='hidden'){invalid=true;return;}
   params.set(key,n.attr('value')??'');
  });
  if(invalid || params.size!==3 || params.get('db_uuid')!==uuid || !/^[A-Za-z0-9._~+\/=-]{1,8192}$/.test(params.get('token')??'') || !(params.get('redirect')===origin+'/odoo/my-subscription' || params.get('redirect')==='/odoo/my-subscription' || oeaTarget(params.get('redirect')??'',origin,name,false))) return;
  accepted.push({url:url.href,body:params.toString()});
 });
 return accepted.length===1?accepted[0]:null;
}
function count(input:unknown):number|null {
 const value=typeof input==='number'?input:typeof input==='string'&&/^-?\d{1,5}$/.test(input)?Number(input):NaN;
 return Number.isSafeInteger(value)&&Math.abs(value)<=99999?value:null;
}
export function parseManagePage(database:Database,html:string,now=new Date(),uuid?:string):Database {
 const $=load(html);$('script,style,template,noscript').remove();
 const components=$('owl-component[name="openerp_enterprise.MyDatabaseInfo"]');
 if(components.length){
  if(components.length!==1)throw new AppError('AMBIGUOUS_DATABASE','Odoo returned multiple Manage information components.');
  let props:any;try{props=JSON.parse(components.attr('props')??'');}catch{throw new AppError('MANAGE_UNAVAILABLE','Odoo returned unsupported Manage information.');}
  const info=props?.subinfo;
  if(!info || typeof info!=='object' || info.db_name!==database.name || (uuid&&info.db_uuid!==uuid) || databaseOrigin(info.origin_url,database.name)!==database.url)throw new AppError('AMBIGUOUS_DATABASE','The Manage page identity did not match the listed database.');
  // Match the official MyDatabaseInfo template's display conditions. Never use
  // next_invoice_date, start_date, prices, or authentication material as expiry.
  const trial=info.sub_plan==='Trial';
  const trialDays=trial?count(info.expireIn):null;
  const subscriptionDays=info.sub_id&&!['Edu','OneAppFree'].includes(info.sub_plan)?count(info.days_valid):null;
  const shownSubscriptionDays=subscriptionDays!==null&&subscriptionDays>0&&subscriptionDays<30?subscriptionDays:null;
  if(trialDays!==null&&shownSubscriptionDays!==null&&trialDays!==shownSubscriptionDays)throw new AppError('AMBIGUOUS_EXPIRATION','Odoo displayed conflicting expiration information.');
  const remainingDays=trialDays??shownSubscriptionDays;
  const expiresAt=info.sub_id?parseExplicitDate(typeof info.until_str==='string'?info.until_str:undefined):null;
  const evidence=[...(trialDays!==null?[`Your trial will expire in ${trialDays} day(s)`]:shownSubscriptionDays!==null?[`Expires in ${shownSubscriptionDays} days`]:[]),...(expiresAt?[`Expires on ${expiresAt}`]:[])];
  return {...database,expiresAt,remainingDays,expirationObservedAt:now.toISOString(),expirationEvidence:evidence.length?`Odoo Manage page: ${evidence.join(' · ')}`:'Odoo Manage page read successfully; no explicit expiration date or days-remaining banner was shown.'};
 }
 if(!$('#database-section').length)throw new AppError('MANAGE_UNAVAILABLE','Odoo did not return the database Manage information page.');
 const text=$('body').text().replace(/\s+/g,' ').trim();const host=new URL(database.url!).hostname;
 const identities=[...text.matchAll(/Your database runs on\s+([a-z0-9][a-z0-9-]*\s*\.\s*odoo\s*\.\s*com)/gi)].map(m=>m[1].replace(/\s/g,'').toLowerCase());
 if(identities.length!==1||identities[0]!==host)throw new AppError('AMBIGUOUS_DATABASE','The Manage page identity did not match the listed database.');
 const banners=$('.alert, [role="alert"]').toArray().map(el=>$(el).text().replace(/\s+/g,' ').trim());
 const days:number[]=[];const dates:string[]=[];const evidence:string[]=[];
 for(const banner of banners){
  const relative=banner.match(/^Your (?:trial|database) will expire in\s+(-?\d{1,5})\s+day\(s\)[.!]?$/i);
  if(relative){days.push(Number(relative[1]));evidence.push(banner);}
  const explicit=banner.match(/^(?:Your (?:trial|database) (?:will expire|expires) (?:on|at)|Expiration date:)\s+(.+?)[.]?$/i);
  if(explicit){const parsed=parseExplicitDate(explicit[1]);if(parsed){dates.push(parsed);evidence.push(banner);}}
 }
 if(new Set(days).size>1||new Set(dates).size>1)throw new AppError('AMBIGUOUS_EXPIRATION','Odoo displayed conflicting expiration information.');
 return {...database,expiresAt:dates[0]??null,remainingDays:days[0]??null,expirationObservedAt:now.toISOString(),expirationEvidence:evidence.length?`Odoo Manage page: ${[...new Set(evidence)].join(' · ')}`:'Odoo Manage page read successfully; no explicit expiration date or days-remaining banner was shown.'};
}

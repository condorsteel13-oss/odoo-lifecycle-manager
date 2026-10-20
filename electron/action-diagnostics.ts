// Only summaries of responses to actions the app itself submitted.
// No cookies, headers, URL parameter values, response bodies or tokens are logged.
const segments=new Set(['odoo-enterprise','confirm-database','invite-users','saas_worker','saas_trial','dup','json','trial-connect','confirm','activate','activation','progress','start','welcome','database','web','odoo','my','my-subscription','auth_oauth','oea','trial','success','wait','new','create','register','status']);
const parameters=new Set(['token','db_uuid','signature','user_signature','login','email','username','access_token','redirect','db','country_id','expiration']);
export function actionDestination(value:string,base:string):string{
  try{
    const url=new URL(value,base);
    const origin=url.origin==='https://www.odoo.com'?'Odoo account':url.origin===base?'Selected database':'Other destination';
    const path=url.pathname.split('/').map(part=>segments.has(part)?part:part?'[redacted]':'').join('/');
    const keys=[...url.searchParams.keys()].map(key=>parameters.has(key)?key:'[redacted]').join(', ');
    return `${origin} ${path}${keys?` (parameters: ${keys}; values omitted)`:''}`;
  }catch{return 'Unrecognized destination (omitted)';}
}

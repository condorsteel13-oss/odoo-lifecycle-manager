import type { BrowserContext, Page } from 'playwright';
import { AppError } from './errors';
import { sameEmail } from './activation';
import { mailSessionSchema, type MailSession } from './session-vault';

export const MAIL_ORIGIN='https://mail.viamtl.com';
const DOCUMENT='/__lifecycle_mail_reader__';
export function tokenIdentity(session:MailSession){
  try{
    const claims=JSON.parse(Buffer.from(session.accessToken.split('.')[1],'base64url').toString('utf8'));
    if(!sameEmail(claims.nameid,session.email)||claims.Impersonating===true||claims.Impersonating==='true'||typeof claims.exp!=='number')throw new Error();
    return {email:session.email,expires:claims.exp*1000};
  }catch{throw new AppError('MAIL_SESSION_EXPIRED','Sign into your own Viamail account again. Its saved identity could not be verified.');}
}
export async function captureMailSession(page:Page):Promise<MailSession>{
  const value=await page.evaluate(()=>{
    try{
      const injector=(window as any).angular.element(document.body).injector();
      const claims=injector.get('claimsService'),auth=injector.get('authStorage');
      if(claims.impersonating())return null;
      return {email:claims.getEmailAddress(),accessToken:auth.getToken(),refreshToken:auth.getRefreshToken()};
    }catch{return null;}
  });
  const parsed=mailSessionSchema.safeParse(value);
  if(!parsed.success)throw new AppError('MAIL_SESSION_EXPIRED','Finish signing into Viamail, then choose Verify Viamail login.');
  tokenIdentity(parsed.data);return parsed.data;
}

// Upgrade an earlier app-owned Viamail profile without asking for the same
// login again. Only a single unambiguous, non-impersonated account is eligible.
// This runs in an inert document; it never opens the Inbox or loads mail scripts.
export async function captureRememberedMailSession(context:BrowserContext):Promise<MailSession|null>{
  const url=MAIL_ORIGIN+'/__lifecycle_session_upgrade__';
  const page=await context.newPage();
  const guard=async(route:import('playwright').Route)=>{
    const request=route.request();let owner:Page|undefined;try{owner=request.frame().page();}catch{}
    if(owner===page&&request.url()===url&&request.method()==='GET'&&request.isNavigationRequest())await route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'none'"},body:'<!doctype html><title>Lifecycle Manager</title>'});
    else await route.abort('blockedbyclient').catch(()=>{});
  };
  await context.route('**/*',guard);
  try{
    const cdp=await context.newCDPSession(page);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');await cdp.send('Network.enable');await cdp.send('Network.setBypassServiceWorker',{bypass:true});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});
    const value=await page.evaluate(()=>{
      try{
        if(localStorage.getItem('impUser'))return null;
        const tokens=JSON.parse(localStorage.getItem('userTokens')??'{}');
        const entries=Object.entries(tokens).filter(([,v]:[string,any])=>typeof v?.accessToken==='string'&&typeof v?.refreshToken==='string');
        if(entries.length!==1)return null;
        const [email,value]=entries[0] as [string,any];
        return {email,accessToken:value.accessToken,refreshToken:value.refreshToken};
      }catch{return null;}
    });
    const parsed=mailSessionSchema.safeParse(value);if(!parsed.success)return null;
    tokenIdentity(parsed.data);return parsed.data;
  }finally{await page.close().catch(()=>{});await context.unroute('**/*',guard);}
}

// After manual login the full mailbox closes. Only fixed authentication and
// scoped read endpoints can run in these inert documents; no mailbox scripts run.
export class MailReader {
  private page:Page|null=null;
  private permit:{url:string;method:string;body?:string}|null=null;
  constructor(private context:BrowserContext,private session:MailSession,private save:(session:MailSession)=>Promise<void>){}
  async install(){
    await this.context.routeWebSocket('**/*',socket=>socket.close());
    await this.context.route('**/*',async route=>{
      const request=route.request();let owner:Page|undefined;try{owner=request.frame().page();}catch{}
      if(owner===this.page&&request.url()===MAIL_ORIGIN+DOCUMENT&&request.isNavigationRequest()&&request.method()==='GET'){
        await route.fulfill({status:200,contentType:'text/html',headers:{'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; connect-src 'self'; form-action 'none'; base-uri 'none'"},body:'<!doctype html><title>Lifecycle Manager — Viamail</title><h1>Viamail connected to Lifecycle Manager</h1><p>Return to Lifecycle Manager. No mailbox controls are available here.</p>'});return;
      }
      const permit=this.permit;
      if(permit&&owner===this.page&&request.resourceType()==='fetch'&&!request.isNavigationRequest()&&!request.redirectedFrom()&&request.url()===permit.url&&request.method()===permit.method&&(permit.body===undefined?!request.postData():request.postData()===permit.body)){
        this.permit=null;await route.continue();return;
      }
      await route.abort('blockedbyclient').catch(()=>{});
    });
    for(const page of this.context.pages())await page.close({runBeforeUnload:false});
    this.page=await this.context.newPage();
    const cdp=await this.context.newCDPSession(this.page);
    await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.send('Network.enable');await cdp.send('Network.setBypassServiceWorker',{bypass:true});
    await this.page.goto(MAIL_ORIGIN+DOCUMENT,{waitUntil:'domcontentloaded',timeout:15000});
  }
  private async request(path:string,body?:Record<string,unknown>,auth=true){
    const url=MAIL_ORIGIN+path,method=body?'POST':'GET',text=body?JSON.stringify(body):undefined;
    this.permit={url,method,body:text};
    try{return await this.page!.evaluate(async({url,method,body,token})=>{
      try{
        const headers:Record<string,string>={};if(body)headers['Content-Type']='application/json';if(token)headers.Authorization='Bearer '+token;
        const response=await fetch(url,{method,body,headers,redirect:'error',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});
        if(!response.headers.get('content-type')?.includes('application/json'))return {status:response.status,data:null};
        const text=await response.text();return {status:response.status,data:text.length<=2_000_000?JSON.parse(text):null};
      }catch{return {status:0,data:null};}
    },{url,method,body:text,token:auth?this.session.accessToken:null});}
    finally{this.permit=null;}
  }
  private async refreshToken(){
    const result=await this.request('/api/v1/auth/refresh-token',{token:this.session.refreshToken,iswebmailrefresh:true});
    if(result.status!==200||!result.data?.accessToken)throw new AppError('MAIL_SESSION_EXPIRED','Viamail needs a new sign-in. Reconnect Viamail on the Connection screen.');
    const parsed=mailSessionSchema.safeParse({email:this.session.email,accessToken:result.data.accessToken,refreshToken:result.data.refreshToken??this.session.refreshToken});
    if(!parsed.success)throw new AppError('MAIL_SESSION_EXPIRED','Viamail returned an unsupported session. Sign in again.');
    tokenIdentity(parsed.data);this.session=parsed.data;
    // Save a rotated refresh token before any subsequent operation.
    await this.save(this.session);
  }
  private async read(path:string,body?:Record<string,unknown>){
    const expired=tokenIdentity(this.session).expires<=Date.now()+60000;
    if(expired)await this.refreshToken();
    let result=await this.request(path,body);
    if(result.status===401&&!expired){await this.refreshToken();result=await this.request(path,body);}
    if(result.status===401||result.status===403)throw new AppError('MAIL_SESSION_EXPIRED','Viamail needs a new sign-in. Reconnect Viamail on the Connection screen.');
    if(result.status!==200||!result.data||result.data.success===false)throw new AppError('MAILBOX_UNAVAILABLE','Viamail could not verify this connection. Check the connection or sign in visibly if it requests a challenge.');
    return result.data;
  }
  async check(){
    const data=await this.read('/api/v1/settings/user-mail');
    if(!data.userMailSettings||typeof data.userMailSettings!=='object')throw new AppError('MAILBOX_UNAVAILABLE','Viamail returned an unsupported connection response. Reconnect to check it.');
    await this.save(this.session);return this.session.email;
  }
  async activationRead(path:'/api/v1/mail/messages'|'/api/v1/mail/message',body:Record<string,unknown>,email:string){
    if(!sameEmail(email,this.session.email)||!sameEmail(String(body.ownerEmailAddress??body.OwnerEmailAddress),email))throw new AppError('MAILBOX_UNAVAILABLE','The Viamail account does not match the signed-in Odoo user. Reconnect the matching mailbox.');
    return this.read(path,body);
  }
}

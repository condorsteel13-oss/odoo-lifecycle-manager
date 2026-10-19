import { chromium, type Browser, type Page, type Route } from 'playwright';
import { load } from 'cheerio';
import { ManualChrome } from './chrome-login';
import { AppError } from './errors';
import { sameEmail, emailAddress } from './activation';
import { validCopyName } from '../src/shared/live';
import { MailReader, captureMailSession, captureRememberedMailSession } from './mail-reader';
import type { SessionVault } from './session-vault';
import { connectionTimeout } from './timeout';

export const WEBMAIL_ORIGIN = 'https://mail.viamtl.com';
export const WEBMAIL_LOGIN = WEBMAIL_ORIGIN + '/interface/root#/login';
export interface MailTarget { copyName: string; email: string; createdAt: string }
function blocked(message: string): never { throw new AppError('MAILBOX_UNAVAILABLE', message); }

export function matchingMessage(m: any, target: MailTarget) {
  const from = emailAddress(m?.from?.email);
  const timestamp = Date.parse(m?.internalDate);
  return Number.isSafeInteger(m?.uid) && m.uid > 0 && m.folder?.toLowerCase() === 'inbox'
    && !!from && /@(?:[a-z0-9-]+\.)?odoo\.com$/i.test(from)
    && typeof m.subject === 'string' && new RegExp('(^|[^a-z0-9-])'+target.copyName+'([^a-z0-9-]|$)','i').test(m.subject)
    && /activat|confirm/i.test(m.subject)
    && Array.isArray(m.recipients) && m.recipients.some((r: any) => sameEmail(emailAddress(r.email),target.email))
    && Number.isFinite(timestamp) && timestamp >= Date.parse(target.createdAt)-60000 && timestamp <= Date.now()+60000;
}
// Email HTML is parsed inertly: no scripts, images, attachments, tracking links or
// read receipts are loaded. The credential-bearing link stays in the main process.
export function extractActivationLink(html: string, target: MailTarget): string {
  if (typeof html !== 'string' || html.length > 1_000_000) return blocked('The activation message format is unsupported.');
  const $=load(html), links=new Set<string>();
  if (!$('body').text().includes(target.copyName)) return blocked('The activation message does not identify the tracked copy.');
  $('a[href]').each((_i,el)=>{
    const text=$(el).text(); if(!/activat|confirm/i.test(text))return;
    try {
      const u=new URL($(el).attr('href')!);
      if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&[`${target.copyName}.odoo.com`,'www.odoo.com'].includes(u.hostname))links.add(u.href);
    } catch {}
  });
  if(links.size!==1)return blocked('The activation message does not contain one unambiguous Odoo activation link for this copy.');
  return [...links][0];
}

export class MailboxBrowser {
  private chrome: ManualChrome;
  private browser: Browser | null=null;
  private reader: MailReader | null=null;
  private headless=false;
  private finish:(()=>void)|null=null;
  private cancel:(()=>void)|null=null;
  private cancelled=false;
  constructor(profile:string,private vault?:SessionVault){this.chrome=new ManualChrome(profile);}
  get isRunning(){return this.chrome.isRunning;}
  async setHeadless(value:boolean){if(value===this.headless)return;await this.close();this.headless=value;}
  finishLogin(){if(!this.finish)throw new AppError('LOGIN_NOT_READY','Wait for Viamail to open first.');this.finish();}
  async connect():Promise<string>{
    await this.close();this.cancelled=false;
    try{
      const endpoint=await this.chrome.launch(WEBMAIL_LOGIN);
      if(this.cancelled)throw new AppError('LOGIN_CANCELLED','Viamail sign-in was cancelled.');
      await new Promise<void>((resolve,reject)=>{
        const cleanup=()=>{clearTimeout(timer);clearInterval(closed);this.finish=null;this.cancel=null;};
        const timer=setTimeout(()=>{cleanup();reject(new AppError('LOGIN_TIMEOUT','Viamail sign-in timed out. Start again when ready.'));},15*60*1000);
        const closed=setInterval(()=>{if(!this.chrome.isRunning)this.cancel?.();},1000);
        this.finish=()=>{cleanup();resolve();};this.cancel=()=>{cleanup();reject(new AppError('LOGIN_CANCELLED','Viamail sign-in was cancelled.'));};
      });
      this.browser=await chromium.connectOverCDP(endpoint,{timeout:15000});
      const context=this.browser.contexts()[0];
      const pages=context.pages().filter(p=>p.url().startsWith(WEBMAIL_ORIGIN+'/interface/root'));
      if(pages.length!==1)return blocked('Keep one Viamail tab open in the app’s Chrome window.');
      const session=await captureMailSession(pages[0]);
      this.reader=new MailReader(context,session,s=>this.vault!.saveMail(s));await this.reader.install();
      const email=await this.reader.check();
      if(this.headless){await this.close();return await this.check();}
      return email;
    }catch(error){await this.close();throw error;}
  }
  async check():Promise<string>{
    try{return await connectionTimeout(()=>this.checkSaved(),'Viamail connection check timed out. Reconnect Viamail or try visible Chrome mode.');}
    catch(error){await this.close();throw error;}
  }
  private async checkSaved():Promise<string>{
    try{
      if(!this.browser?.isConnected()||!this.reader||!this.chrome.isRunning){
        await this.close();
        let session=await this.vault?.restoreMail();
        const endpoint=await this.chrome.launch('about:blank',this.headless);
        this.browser=await chromium.connectOverCDP(endpoint,{timeout:15000});
        session??=await captureRememberedMailSession(this.browser.contexts()[0]);
        if(!session)throw new AppError('MAIL_SESSION_EXPIRED','Connect to Viamail and sign in once to save the connection.');
        this.reader=new MailReader(this.browser.contexts()[0],session,s=>this.vault!.saveMail(s));await this.reader.install();
      }
      return await this.reader.check();
    }catch(error){await this.close();throw error;}
  }
  async open(){await this.check();}
  async close(){this.cancelled=true;this.cancel?.();this.cancel=null;this.finish=null;this.reader=null;const browser=this.browser;this.browser=null;await this.chrome.close();await browser?.close().catch(()=>{});}
  async findActivationLink(target:MailTarget):Promise<string>{
    if(!validCopyName(target.copyName)||!emailAddress(target.email)||!Number.isFinite(Date.parse(target.createdAt)))return blocked('The tracked activation details are invalid.');
    const email=await this.check();
    if(!sameEmail(email,target.email))return blocked(`Connect Viamail as ${target.email}. The app will not read a different mailbox.`);
    return scopedActivationMessage((path,body)=>this.reader!.activationRead(path,body,target.email),target);
  }
}

export async function readActivationMessage(page:Page,target:MailTarget):Promise<string>{
    if(!validCopyName(target.copyName)||!emailAddress(target.email)||!Number.isFinite(Date.parse(target.createdAt)))return blocked('The tracked activation details are invalid.');
    if(new URL(page.url()).origin!==WEBMAIL_ORIGIN)return blocked('Open the configured webmail site.');
    const context=page.context();
    // Only a projected identity leaves the browser; credentials never do.
    const account=await page.evaluate(()=>{try{const inj=(window as any).angular.element(document.body).injector();return inj.get('claimsService').getEmailAddress() as string;}catch{return null;}});
    if(!sameEmail(emailAddress(account),target.email))return blocked(`Sign into ${target.email} in the webmail window. The app will not read a different mailbox.`);
    let permit:{url:string;body:string}|null=null;
    const guard=async(route:Route)=>{
      const request=route.request();let owner:Page|undefined;try{owner=request.frame().page();}catch{}
      if(permit&&owner===page&&request.resourceType()==='fetch'&&!request.isNavigationRequest()&&!request.redirectedFrom()&&request.method()==='POST'&&request.url()===permit.url&&request.postData()===permit.body){permit=null;await route.continue();}
      else await route.abort('blockedbyclient').catch(()=>{});
    };
    await context.route('**/*',guard);
    const cdp=await context.newCDPSession(page);
    await cdp.send('Network.enable');await cdp.send('Network.setBypassServiceWorker',{bypass:true});await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
    const request=async(path:'/api/v1/mail/messages'|'/api/v1/mail/message',params:Record<string,unknown>)=>{
      const url=WEBMAIL_ORIGIN+path,body=JSON.stringify(params);permit={url,body};
      const result=await page.evaluate(async({url,body,email})=>{
        try{
          const inj=(window as any).angular.element(document.body).injector();
          if(String(inj.get('claimsService').getEmailAddress()).toLowerCase()!==email.toLowerCase())return null;
          const token=inj.get('authStorage').getToken();if(typeof token!=='string'||!token)return null;
          const response=await fetch(url,{method:'POST',body,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},redirect:'error',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});
          if(response.status!==200||!response.headers.get('content-type')?.includes('application/json'))return null;
          const text=await response.text();return text.length<=2_000_000?JSON.parse(text):null;
        }catch{return null;}
      },{url,body,email:target.email});
      if(!result)return blocked('Webmail could not complete the scoped read. Sign in again if the session expired.');
      return result;
    };
    try{
      return await scopedActivationMessage(request,target);
    }finally{permit=null;await context.unroute('**/*',guard);await cdp.detach().catch(()=>{});}
  }

export async function scopedActivationMessage(request:(path:'/api/v1/mail/messages'|'/api/v1/mail/message',body:Record<string,unknown>)=>Promise<any>,target:MailTarget):Promise<string>{
      // Inbox only; no shared mailboxes, archives or unrelated message bodies.
      const result=await request('/api/v1/mail/messages',{folder:'inbox',ownerEmailAddress:target.email,sortType:0,sortAscending:false,query:target.copyName,skip:0,take:20,selectedIds:[]});
      const rows=result.results??result.Results;
      if(!Array.isArray(rows)||rows.length>20)return blocked('Webmail returned an unsupported search result.');
      const matches=rows.filter(m=>matchingMessage(m,target)).sort((a,b)=>Date.parse(b.internalDate)-Date.parse(a.internalDate));
      if(!matches.length)throw new AppError('MAIL_NOT_ARRIVED','No matching Odoo activation message has arrived in this user’s Inbox. Wait briefly, then read again.');
      if(matches.length>1&&matches[0].internalDate===matches[1].internalDate)return blocked('More than one activation message has the same timestamp. Inspect the mailbox manually.');
      const message=(await request('/api/v1/mail/message',{Folder:'inbox',UID:matches[0].uid,OwnerEmailAddress:target.email})).messageData;
      if(!message||message.uid!==matches[0].uid||message.subject!==matches[0].subject)return blocked('The message identity changed. No activation link was opened.');
      return extractActivationLink(message.messageHTML,target);
}

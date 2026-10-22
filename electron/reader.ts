import type { BrowserContext, Page } from 'playwright';
import { AppError } from './errors';
import { databaseOrigin } from './metadata';
import { connectForm, oeaTarget, parseManagePage, validateTarget } from './manage';
import type { Database } from '../src/shared/types';
import { assertCopyName, parseLiveInspection, type LiveInspection } from './live-contract';
import { parseActivation, sameEmail, activationURL } from './activation';
import { actionDestination } from './action-diagnostics';
import { ActivationFlow, MemoryActivationJournal, type ActivationJournal } from './activation-flow';
export const ACCOUNT_ORIGIN='https://www.odoo.com';
export const LIST_PATH='/odoo-enterprise/databases';
export const SESSION_PATH='/web/session/get_session_info';
export const INFO_PATH='/saas_worker/db/info/json';
const DOCUMENT_PATH='/__lifecycle_read_only__';
interface Permit {url:string;method:'GET'|'POST';body?:string;contentType?:string;page:Page}
interface Result {status:number;location:string|null;body:string;contentType:string}
export class MetadataReader {
 private permit:Permit|null=null;
 private violation:AppError|null=null;
 private pages=new Set<Page>();
 private origins=new Set([ACCOUNT_ORIGIN]);
 constructor(private context:BrowserContext,private createPage:()=>Promise<Page>=()=>context.newPage(),private diagnostic:(event:AppError)=>void=()=>{},private activationJournal:ActivationJournal=new MemoryActivationJournal()){}
 async install(beforeClose?:()=>Promise<void>){
  const existingPages=this.context.pages();
  await this.context.routeWebSocket('**/*',socket=>socket.close());
  await this.context.route('**/*',async route=>{
   const request=route.request();let page:Page|null=null;
   try{page=request.frame().page();}catch{}
   const url=new URL(request.url());const owned=page&&this.pages.has(page);
   if(owned&&!this.violation&&request.isNavigationRequest()&&request.method()==='GET'&&url.pathname===DOCUMENT_PATH&&this.origins.has(url.origin)&&!url.search&&!url.hash){
    await route.fulfill({status:200,contentType:'text/html',headers:{'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"},body:'<!doctype html><title>Lifecycle Manager — read only</title><h1>Reading database metadata</h1><p>Return to Lifecycle Manager. No database controls are available here.</p>'});return;
   }
   const permit=this.permit;
   if(owned&&!this.violation&&permit&&page===permit.page&&!request.isNavigationRequest()&&request.resourceType()==='fetch'&&request.method()===permit.method&&request.url()===permit.url&&!request.redirectedFrom()&&(permit.method==='GET'?!request.postData():request.postData()===permit.body&&request.headers()['content-type']===permit.contentType)){
    this.permit=null;await route.continue();return;
   }
   await route.abort('blockedbyclient').catch(()=>{});
   if(owned&&url.pathname!=='/favicon.ico') this.violation=new AppError('SAFETY_STOP','An unexpected request was blocked. No new discovery was accepted.');
  });
  await beforeClose?.();
  for(const page of existingPages) await page.close({runBeforeUnload:false});
 }
 allowDatabases(origins:string[]){
  for(const origin of origins){if(databaseOrigin(origin)!==origin)throw new AppError('SAFETY_STOP','An unsupported database origin was rejected.');this.origins.add(origin);}
 }
 // All callers below construct fixed, validated requests. No generic transport is
 // available to IPC, remote HTML or renderer code. Native fetch never auto-redirects.
 private async request(url:string,options:{body?:string;contentType?:string;redirect?:'error'|'manual'}={}):Promise<Result>{
  this.assertSafe();const origin=new URL(url).origin;
  if(!this.origins.has(origin))throw new AppError('SAFETY_STOP','An unsupported request origin was rejected.');
  const page=await this.createPage();this.pages.add(page);
  try{
   const cdp=await this.context.newCDPSession(page);
   await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
   await cdp.send('Network.enable');await cdp.send('Network.setBypassServiceWorker',{bypass:true});
   await page.goto(origin+DOCUMENT_PATH,{waitUntil:'domcontentloaded',timeout:15000});
   let requestId:string|undefined;let redirect:{status:number;location:string|null}|undefined;
   cdp.on('Network.requestWillBeSent',event=>{if(event.request.url===url) requestId=event.requestId;});
   let receivedHeaders!:()=>void;
   const headers=new Promise<void>(resolve=>{receivedHeaders=resolve;});
   cdp.on('Network.responseReceivedExtraInfo',event=>{
    if(event.requestId===requestId&&event.statusCode>=300&&event.statusCode<400){
     const location=Object.entries(event.headers).find(([key])=>key.toLowerCase()==='location')?.[1];
     redirect={status:event.statusCode,location:typeof location==='string'?location:null};receivedHeaders();
    }
   });
   const method=options.body===undefined?'GET':'POST';
   this.permit={page,url,method,body:options.body,contentType:options.contentType};
   const result=await page.evaluate(async({url,method,body,contentType,redirect})=>{
    try{
     const response=await fetch(url,{method,body,headers:contentType?{'Content-Type':contentType}:{},credentials:'same-origin',redirect,cache:'no-store',signal:AbortSignal.timeout(30000)});
     const text=await response.text();
     if(text.length>12_000_000)return {status:413,body:'',contentType:''};
     return {status:response.status,body:text,contentType:response.headers.get('content-type')??''};
    }catch{return {status:-1,body:'',contentType:''};}
   },{url,method,body:options.body,contentType:options.contentType,redirect:options.redirect??'error'});
   if(result.status===0&&options.redirect==='manual'){
    let timer:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([headers,new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]);clearTimeout(timer);
   }
   this.assertSafe();return {...result,...redirect,location:redirect?.location??null};
  }finally{this.permit=null;this.pages.delete(page);await page.close().catch(()=>{});}
 }
 private async json(origin:string,path:string,params?:Record<string,unknown>){
  const allowed=(origin===ACCOUNT_ORIGIN&&path===LIST_PATH&&JSON.stringify(params)==='{"share":false}')||(origin!==ACCOUNT_ORIGIN&&this.origins.has(origin)&&((path===SESSION_PATH&&JSON.stringify(params)==='{}')||(path===INFO_PATH&&params===undefined)));
  if(!allowed)throw new AppError('SAFETY_STOP','Only fixed database metadata reads are supported.');
  const body=params===undefined?'{}':JSON.stringify({jsonrpc:'2.0',method:'call',params,id:1});
  const response=await this.request(origin+path,{body,contentType:'application/json'});
  if(response.status!==200||!response.contentType.includes('application/json'))throw new AppError(response.status===401||response.status===403?'SESSION_EXPIRED':'METADATA_UNAVAILABLE',`Odoo could not complete the metadata read (HTTP ${response.status>0?response.status:'unavailable'}).`);
  try{return JSON.parse(response.body) as unknown;}catch{throw new AppError('INTERFACE_CHANGED','Odoo returned an unsupported metadata response.');}
 }
 list(){return this.json(ACCOUNT_ORIGIN,LIST_PATH,{share:false});}
 session(origin:string){return this.json(origin,SESSION_PATH,{});}
 async authenticate(origin:string,uuid:string,name:string){
  validateTarget(origin,uuid,name);
  if(!this.origins.has(origin))throw new AppError('SAFETY_STOP','The database was not present in the account list.');
  let response=await this.request(`${ACCOUNT_ORIGIN}/my/databases/connect/${uuid}?manage_db=true`,{redirect:'manual'});
  for(let hop=0;hop<4;hop++){
   if(response.location){
    if(hop>0 && new URL(response.location,origin).href===origin+'/odoo/my-subscription') return;
    const target=oeaTarget(response.location,origin,name);
    if(!target)throw new AppError('DATABASE_LOGIN_UNSUPPORTED','Odoo returned an unsupported sign-in redirect. No redirect was followed.');
    // The existing-user OEA controller authenticates and may redirect to the app.
    // The returned application redirect is intentionally ignored.
    await this.request(target,{redirect:'manual'});return;
   }
   if(response.status===200&&response.contentType.includes('text/html')){
    const form=connectForm(response.body,origin,uuid,name);
    if(form){response=await this.request(form.url,{body:form.body,contentType:'application/x-www-form-urlencoded',redirect:'manual'});continue;}
   }
   throw new AppError('DATABASE_LOGIN_REQUIRED',`Odoo requires a supported database sign-in handoff (HTTP ${response.status>0?response.status:'unavailable'}).`);
  }
  throw new AppError('DATABASE_LOGIN_UNSUPPORTED','Odoo returned too many sign-in handoffs.');
 }
 private async manageHTML(database:Database,uuid:string):Promise<string>{
  const origin=database.url!;validateTarget(origin,uuid,database.name);
  if(!this.origins.has(origin))throw new AppError('SAFETY_STOP','The database was not present in the account list.');
  const result=await this.json(origin,INFO_PATH) as {result?:unknown;error?:unknown};
  if(result.error){
   const error=result.error as {code?:unknown;data?:{name?:unknown}};
   if(error.code===100||error.data?.name==='odoo.http.SessionExpiredException')throw new AppError('SESSION_EXPIRED','Odoo requires a new database sign-in.');
   if(['odoo.exceptions.AccessError','odoo.exceptions.AccessDenied'].includes(String(error.data?.name)))throw new AppError('MANAGE_ACCESS_DENIED','Odoo denied access to the Manage information page.');
   throw new AppError('MANAGE_SERVER_ERROR','Odoo returned a server error for the Manage information page.');
  }
  if(typeof result.result!=='string'||!/^odt_[A-Za-z0-9_=-]{10,16384}$/.test(result.result))throw new AppError('MANAGE_UNAVAILABLE','Odoo returned an unsupported Manage information response.');
  const url=new URL('/my/database',ACCOUNT_ORIGIN);url.searchParams.set('lang','en_US');url.searchParams.set('token',result.result);
  const response=await this.request(url.href);
  if(response.status!==200||!response.contentType.includes('text/html'))throw new AppError('MANAGE_UNAVAILABLE',`Odoo could not return the Manage information page (HTTP ${response.status>0?response.status:'unavailable'}).`);
  return response.body;
 }
 async manage(database:Database,uuid:string):Promise<Database>{return parseManagePage(database,await this.manageHTML(database,uuid),new Date(),uuid);}
 async inspectLive(database:Database,uuid:string,parentUuid:string|null):Promise<LiveInspection>{
  return parseLiveInspection(database,uuid,parentUuid,await this.manageHTML(database,uuid));
 }
 async activation(target:LiveInspection){
  validateTarget(target.database.url!,target.uuid,target.database.name);
  const response=await this.request(target.database.url!+'/saas_worker/trial_info',{body:JSON.stringify({jsonrpc:'2.0',method:'call',params:{},id:1}),contentType:'application/json'});
  if(response.status!==200||!response.contentType.includes('application/json'))throw new AppError('ACTIVATION_UNAVAILABLE','Odoo could not read activation status. No email was sent.');
  let data:unknown;try{data=JSON.parse(response.body);}catch{throw new AppError('ACTIVATION_UNAVAILABLE','Odoo returned an unsupported activation response.');}
  return parseActivation(data);
 }
 async sendActivation(target:LiveInspection,expectedEmail:string){
  // Resolve the email again from this database's current authenticated user.
  // The renderer cannot supply an arbitrary recipient.
  const current=await this.activation(target);
  if(!sameEmail(current.userEmail,expectedEmail))throw new AppError('ACTIVATION_CHANGED','The signed-in user changed. No activation email was sent.');
  if(!current.pending||sameEmail(current.recipientEmail,current.userEmail))return;
  const result=await this.liveRPC(target.database.url!,'/saas_worker/send_activation_email',{activation_email:current.userEmail});
  if(typeof result.success!=='string'||!result.success||result.error)throw new AppError('ACTIVATION_SEND_UNKNOWN','The activation email was not confirmed. Check the mailbox; no automatic resend will occur.');
 }
 async activateFromEmail(target:LiveInspection,link:string){
  validateTarget(target.database.url!,target.uuid,target.database.name);
  const info=await this.activation(target);
  if(!info.pending)return;
  const u=activationURL(link,target.database.name,info.userEmail);
  await this.activationFlow().run({origin:target.database.url!,name:target.database.name,uuid:target.uuid,email:info.userEmail},u.href);
 }
 private activationFlow(){return new ActivationFlow(this.activationJournal,url=>this.request(url,{redirect:'manual'}),this.diagnostic);}
 async resumeActivation(target:LiveInspection,expectedEmail:string){
  validateTarget(target.database.url!,target.uuid,target.database.name);
  const info=await this.activation(target);
  if(!sameEmail(info.userEmail,expectedEmail))throw new AppError('ACTIVATION_CHANGED','The signed-in user changed. No activation handoff was opened.');
  await this.activationFlow().run({origin:target.database.url!,name:target.database.name,uuid:target.uuid,email:info.userEmail});
 }
 // These are the only mutation adapters. They are reachable only from the manual
 // live service after a single-use review, native confirmation and durable intent.
 // Only activation's identity-bound handoffs can redirect. No remote script,
 // automatic mutation retry or arbitrary method is accepted.
 private async liveRPC(origin:string,path:string,params:Record<string,unknown>):Promise<Record<string,any>>{
  const response=await this.request(origin+path,{body:JSON.stringify({jsonrpc:'2.0',method:'call',params,id:1}),contentType:'application/json'});
  if(response.status!==200||!response.contentType.includes('application/json'))throw new AppError('LIVE_OUTCOME_UNKNOWN','Odoo did not confirm the result. Do not retry; inspect the live action log and verify in Odoo.');
  let envelope:any;try{envelope=JSON.parse(response.body);}catch{}
  if(envelope?.jsonrpc!=='2.0'||envelope.error||!envelope.result||typeof envelope.result!=='object'||Array.isArray(envelope.result))throw new AppError('LIVE_OUTCOME_UNKNOWN','Odoo did not confirm the result. Do not retry; inspect the live action log and verify in Odoo.');
  return envelope.result;
 }
 async duplicateLive(target:LiveInspection,copyName:string){
  assertCopyName(copyName,target.database.name);
  validateTarget(target.database.url!,target.uuid,target.database.name);
  const started=Date.now();
  let result:Record<string,any>;
  try{result=await this.liveRPC(target.database.url!,'/saas_worker/dup/json',{to:copyName,oauth_token:target.token,stay_on_portal:false,test:true,support:false});}
  catch(error){
   this.diagnostic(new AppError('DUPLICATION_RESPONSE',`Duplication response for ${copyName} was not confirmed after ${Math.round((Date.now()-started)/1000)} seconds. No request was retried.`));
   throw error;
  }
  if(typeof result.success!=='string'||!result.success)throw new AppError('LIVE_OUTCOME_UNKNOWN','Duplication was not confirmed. Use Verify copy; never resubmit an uncertain request.');
  this.diagnostic(new AppError('DUPLICATION_RESPONSE',`Duplication response for ${copyName}: success destination ${actionDestination(result.success,target.database.url!)} was not followed.`));
  // Odoo returns a progress/application URL. Never navigate or execute it.
 }
 async checkCopyName(name:string,original:string){
  assertCopyName(name,original);
  let result:Record<string,any>;
  try{result=await this.liveRPC(ACCOUNT_ORIGIN,'/odoo-enterprise/trial-check',{dbname:name});}
  catch{throw new AppError('NAME_CHECK_UNAVAILABLE','Odoo could not verify name availability. No duplication request was sent.');}
  if(result.error)throw new AppError('COPY_NAME_TAKEN','Odoo reports that this copy name is unavailable. Choose another name.');
 }
 async deleteLive(target:LiveInspection){
  validateTarget(target.database.url!,target.uuid,target.database.name);
  const params:Record<string,unknown>={token:target.token,access_token:target.accessToken,is_paid:target.isPaid};
  if(target.subId)params.sub_id=target.subId;
  const portal=await this.liveRPC(ACCOUNT_ORIGIN,'/my/databases/delete',params);
  if(portal.result!==true)throw new AppError('LIVE_OUTCOME_UNKNOWN','The first deletion step was not confirmed. Stop and verify in Odoo; no database drop was sent.');
  const worker=await this.liveRPC(target.database.url!,'/saas_worker/drop/json',{oauth_token:target.token,db_name:target.database.name,db_uuid:target.uuid});
  if(worker.result!==true)throw new AppError('LIVE_OUTCOME_UNKNOWN','The subscription step may have completed, but database deletion was not confirmed. Do not retry; verify in Odoo.');
 }
 assertSafe(){if(this.violation)throw this.violation;}
}

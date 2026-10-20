import { load } from 'cheerio';
import { z } from 'zod';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionCipher } from './session-vault';
import { activationURL, sameEmail } from './activation';
import { AppError } from './errors';

export interface ActivationTarget { origin:string; name:string; uuid:string; email:string }
export interface ActivationResponse { status:number; location:string|null; body:string; contentType:string }
export const activationCheckpointSchema=z.object({
  version:z.literal(1),origin:z.url(),name:z.string().max(50),uuid:z.uuid(),email:z.email(),
  stage:z.enum(['account-submitting','worker-pending','worker-submitting','completion-pending','complete']),
  url:z.string().max(16384).nullable(),updatedAt:z.iso.datetime(),
}).strict();
export type ActivationCheckpoint=z.infer<typeof activationCheckpointSchema>;
export interface ActivationJournal {
  read(uuid:string):Promise<ActivationCheckpoint|null>;
  write(value:ActivationCheckpoint):Promise<void>;
}
export class MemoryActivationJournal implements ActivationJournal {
  private entries=new Map<string,ActivationCheckpoint>();
  async read(uuid:string){return structuredClone(this.entries.get(uuid)??null);}
  async write(value:ActivationCheckpoint){this.entries.set(value.uuid,structuredClone(activationCheckpointSchema.parse(value)));}
}
// Signed redirects are credentials: only macOS-encrypted checkpoints retain them.
// Ordinary history, diagnostics and renderer IPC never receive their values.
export class EncryptedActivationJournal implements ActivationJournal {
  constructor(private folder:string,private cipher:SessionCipher){}
  private path(uuid:string){return join(this.folder,z.uuid().parse(uuid)+'.enc');}
  private available(){if(!this.cipher.available())throw new AppError('ACTIVATION_STORAGE','Unlock macOS secure storage before completing activation.');}
  async read(uuid:string){
    this.available();
    try{
      const bytes=await readFile(this.path(uuid));
      if(bytes.length>100_000)throw new Error();
      const value=activationCheckpointSchema.parse(JSON.parse(this.cipher.decrypt(bytes)));
      if(value.uuid!==uuid)throw new Error();
      return value;
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw new AppError('ACTIVATION_STORAGE','The activation checkpoint could not be unlocked. No request was replayed.');
    }
  }
  async write(value:ActivationCheckpoint){
    this.available();
    const parsed=activationCheckpointSchema.parse(value),path=this.path(parsed.uuid);
    try{
      await mkdir(this.folder,{recursive:true,mode:0o700});await chmod(this.folder,0o700);
      await writeFile(path+'.tmp',this.cipher.encrypt(JSON.stringify(parsed)),{mode:0o600});await chmod(path+'.tmp',0o600);
      await rename(path+'.tmp',path);
    }catch{throw new AppError('ACTIVATION_STORAGE','The activation checkpoint could not be saved. No further request was sent.');}
  }
}
function unsupported():never{throw new AppError('ACTIVATION_HANDOFF_UNSUPPORTED','Odoo returned an unsupported activation handoff. It is saved securely; the original is retained and deletion is blocked.');}
function exactURL(value:string,origin:string){
  let u:URL;try{u=new URL(value,origin);}catch{return unsupported();}
  if(u.origin!==origin||u.username||u.password||u.hash||u.port||value.length>16384)unsupported();
  return u;
}
export function activationCompletionText(body:string){
  const $=load(body);$('script,style,template,noscript').remove();
  // Text nodes may be separated by a <br> or adjacent headings, with no literal
  // whitespace in the HTML. Preserve those visual word boundaries.
  $('body *').each((_,node)=>{$(node).before(' ').after(' ');});
  return $('body').text().replace(/\s+/g,' ').trim();
}
// This shape is safe to diagnose: no parameter values, signatures or other hosts.
export function activationHandoffShape(value:string,target:ActivationTarget){
  const u=exactURL(value,target.origin);
  const path=/^\/saas_worker\/[a-z_]{1,48}$/.test(u.pathname)?u.pathname:'[unsupported path]';
  const keys=[...u.searchParams.keys()].map(k=>/^[a-z_]{1,48}$/.test(k)?k:'[omitted]');
  const action=u.searchParams.get('action')??'',flag=(key:string)=>/^(True|False|true|false|0|1)$/.test(u.searchParams.get(key)??'')?u.searchParams.get(key):'unsupported';
  const actionLabel=action==='base.action_run_ir_action_todo'?action:'unsupported';
  return `${path}; parameters: ${keys.join(', ')}; copy identity ${u.searchParams.get('db_uuid')===target.uuid?'matches':'not confirmed'}; email ${sameEmail(u.searchParams.get('email'),target.email)?'matches':'not confirmed'}; action ${actionLabel}; freemium ${flag('activate_freemium')}; invite ${flag('invite')}; user ID numeric ${/^[1-9]\d{0,14}$/.test(u.searchParams.get('odoo_com_uid')??'')}; name valid ${/^[^\u0000-\u001f\u007f]{1,254}$/.test(u.searchParams.get('name')??'')}; confirmation token valid ${/^[-A-Za-z0-9._~+%=]{16,4096}$/.test(u.searchParams.get('confirm_token')??'')}. Credential values omitted.`;
}
export function activationWorkerURL(value:string,target:ActivationTarget):URL {
  const u=exactURL(value,target.origin),keys=[...u.searchParams.keys()].sort();
  const expected=['action','activate_freemium','confirm_token','db_uuid','email','invite','name','odoo_com_uid'];
  if(u.pathname!=='/saas_worker/signin'||JSON.stringify(keys)!==JSON.stringify(expected)
    ||u.searchParams.get('db_uuid')!==target.uuid||!sameEmail(u.searchParams.get('email'),target.email)
    ||u.searchParams.get('action')!=='base.action_run_ir_action_todo'
    ||!/^[1-9]\d{0,14}$/.test(u.searchParams.get('odoo_com_uid')??'')
    ||!/^[^\u0000-\u001f\u007f]{1,254}$/.test(u.searchParams.get('name')??'')
    ||!/^[-A-Za-z0-9._~+%=]{16,4096}$/.test(u.searchParams.get('confirm_token')??'')
    ||u.searchParams.get('activate_freemium')!=='False'
    ||u.searchParams.get('invite')!=='True')unsupported();
  // Forward Odoo's signed URL unchanged; never construct an expiry or token.
  return u;
}
export function activationCompletionURL(value:string,target:ActivationTarget):URL {
  const u=exactURL(value,'https://www.odoo.com'),keys=[...u.searchParams.keys()].sort();
  if(u.pathname!=='/odoo-enterprise/invite-users'
    ||JSON.stringify(keys)!==JSON.stringify(['db_uuid','login','user_signature'])
    ||u.searchParams.get('db_uuid')!==target.uuid||!sameEmail(u.searchParams.get('login'),target.email)
    ||!/^[-A-Za-z0-9._~+%=]{16,2048}$/.test(u.searchParams.get('user_signature')??''))unsupported();
  return u;
}
export class ActivationFlow {
  constructor(private journal:ActivationJournal,private request:(url:string)=>Promise<ActivationResponse>,
    private diagnostic:(event:AppError)=>void,
    private workerURL:typeof activationWorkerURL=activationWorkerURL){}
  async run(target:ActivationTarget,link?:string){
    let saved=await this.journal.read(target.uuid);
    if(saved&&(saved.origin!==target.origin||saved.name!==target.name||!sameEmail(saved.email,target.email)))
      throw new AppError('ACTIVATION_CHANGED','The saved activation identity does not match this copy and signed-in user.');
    if(saved?.stage==='complete')return;
    if(saved&&Date.now()-Date.parse(saved.updatedAt)>24*60*60_000)
      throw new AppError('ACTIVATION_HANDOFF_EXPIRED','The saved activation handoff expired. Inspect this copy in Odoo; no request was replayed.');
    const save=async(stage:ActivationCheckpoint['stage'],url:string|null)=>{
      const next:ActivationCheckpoint={version:1,...target,stage,url,updatedAt:new Date().toISOString()};
      await this.journal.write(next);saved=next;
    };
    if(!saved){
      if(!link)throw new AppError('ACTIVATION_HANDOFF_MISSING','No saved activation handoff is available. No link was replayed.');
      const u=activationURL(link,target.name,target.email);
      await save('account-submitting',null);
      const response=await this.request(u.href);
      if(![302,303].includes(response.status)||!response.location)
        throw new AppError('ACTIVATION_UNKNOWN','Odoo did not return the expected activation handoff. No request will be replayed.');
      // Save the exact first-party response before attempting the database hop.
      const next=exactURL(response.location,target.origin);
      await save('worker-pending',next.href);
    }
    if(saved!.stage==='account-submitting'||saved!.stage==='worker-submitting')
      throw new AppError('ACTIVATION_UNKNOWN','A previous activation request has an uncertain outcome. It will not be replayed.');
    if(saved!.stage==='worker-pending'){
      const value=saved!.url!;
      this.diagnostic(new AppError('ACTIVATION_HANDOFF',`Activation handoff for ${target.name}: ${activationHandoffShape(value,target)}`));
      const u=this.workerURL(value,target);
      await save('worker-submitting',null);
      const response=await this.request(u.href);
      if(![302,303].includes(response.status)||!response.location)
        throw new AppError('ACTIVATION_UNKNOWN','The database activation handoff did not return its completion page. It will not be replayed.');
      const completion=exactURL(response.location,'https://www.odoo.com');
      await save('completion-pending',completion.href);
    }
    if(saved!.stage==='completion-pending'){
      const u=activationCompletionURL(saved!.url!,target);
      // This last route is a read-only completion page; no invitations are sent.
      const response=await this.request(u.href);
      const text=response.status===200&&response.contentType.includes('text/html')?activationCompletionText(response.body):'';
      const challenge=/verify you are human|just a moment|verification failed|checking your browser/i.test(text);
      this.diagnostic(new AppError('ACTIVATION_COMPLETION_RESPONSE',`Completion page for ${target.name}: HTTP ${response.status}; HTML ${response.contentType.includes('text/html')}; verification challenge ${challenge}. Page content and signed URL omitted.`));
      if(response.status!==200||!response.contentType.includes('text/html')||!response.body.trim()||challenge)
        throw new AppError('ACTIVATION_COMPLETION_PENDING','The activation completion page is not confirmed. Complete activation can recheck this page without replaying the activation requests.');
      // This checkpoint confirms only that the identity-bound redirect chain
      // completed. LiveService must independently confirm activated trial status
      // and positive, reconciled Manage expiry before marking the copy verified.
      // Odoo's completion HTML can render or translate its message client-side.
      await save('complete',null);
      this.diagnostic(new AppError('ACTIVATION_COMPLETE',`Activation redirects completed for ${target.name}. Fresh activation status and Manage expiry must now be verified. No invitations were sent.`));
    }
  }
}

import { withProgress, type ProgressStep, type ProgressStatus } from '../src/shared/progress';
import { activationEmailWaitMs, waitLabel } from '../src/shared/workflow';
import { z } from 'zod';
import type { Database } from '../src/shared/types';
import type { LiveConfirmation, LiveRecord, LiveReview } from '../src/shared/live';
import { daysRemaining } from '../src/domain/dates';
import { AppError } from './errors';
import { assertCopyName, identityFingerprint, type LiveInspection } from './live-contract';
import type { ListedDatabase } from './metadata';
import { sameEmail, activationURL, type ActivationInfo } from './activation';

export interface LiveConnection {
  checkCopyName(name:string,original:string):Promise<void>;
  liveList(): Promise<ListedDatabase[]>;
  inspectLive(id: string): Promise<LiveInspection>;
  duplicateLive(target: LiveInspection, name: string): Promise<void>;
  deleteLive(target: LiveInspection): Promise<void>;
  activation(target: LiveInspection): Promise<ActivationInfo>;
  sendActivation(target: LiveInspection, expectedEmail: string): Promise<void>;
  activateFromEmail(target: LiveInspection, link: string): Promise<void>;
  resumeActivation(target: LiveInspection, email: string): Promise<void>;
}
export type NativeConfirmation = (review: LiveReview) => Promise<boolean>;
export interface ActivationStepReview {
  action: 'send-activation' | 'activate' | 'resume-activation';
  originalName: string; copyName: string; email: string;
}
export type NativeStepConfirmation = (review: ActivationStepReview) => Promise<boolean>;
const confirmation = z.object({ ticket: z.string().uuid(), typedName: z.string().max(101), acknowledged: z.literal(true), backupConfirmed: z.boolean().optional(), backupReference: z.string().trim().max(1000).optional(), integrityConfirmed: z.boolean().optional(), integrityNotes: z.string().trim().max(2000).optional(), subscriptionReviewed: z.boolean().optional() }).strict();
function fail(message: string): never { throw new AppError('LIVE_BLOCKED', message); }
const TTL = 5 * 60000;
type Ticket = { review: LiveReview; fingerprint: string; uuid: string; copyUuid: string | null };

export class LiveService {
  private ticket: Ticket | null = null;
  private storageFault = false;
  constructor(private browser: LiveConnection, private records: () => LiveRecord[], private save: (records: LiveRecord[]) => Promise<void>, private ready: () => boolean, private confirm: NativeConfirmation, private execution:{deletionAllowed?:()=>boolean;confirmStep?:NativeStepConfirmation;activationEmailDelayMinutes?:()=>number;automaticAllowed?:()=>boolean;beforeMutation?:()=>void}={}) {}
  private async approveStep(action:ActivationStepReview['action'],record:LiveRecord,email:string) {
    this.execution.beforeMutation?.();
    if(!await this.execution.confirmStep?.({action,originalName:record.original.name,copyName:record.copyName,email})){
      await this.reportProgress(record.id,action==='send-activation'?'waiting-email':'activating','stopped','Confirmation cancelled before submission. No new database action was sent.');
      throw new AppError('LIVE_CONFIRMATION_CANCELLED','Step cancelled. The original is retained. Use Continue lifecycle when ready; no request was submitted for this step.');
    }
    this.execution.beforeMutation?.();
    this.assertReady();
  }
  async reportProgress(id:string,step:ProgressStep,status:ProgressStatus,detail?:string) {
    const record=this.record(id),next=withProgress(record,step,status,detail);
    if(next!==record)await this.put(next);
  }
  canDeleteOriginal(id:string) {
    this.record(id);
    return this.execution.deletionAllowed?.()===true;
  }
  cancel() { this.ticket = null; }
  pendingReview(){return this.ticket?structuredClone(this.ticket.review):null;}
  private assertReady() { if (!this.ready() || this.storageFault) fail('Live actions require a connected Odoo account and an intact local action log.'); }
  private async put(record: LiveRecord) {
    try { await this.save([record, ...this.records().filter(r => r.id !== record.id)]); }
    catch { this.storageFault = true; fail('The action log could not be saved. Live actions are locked. An in-flight action may have completed; verify in Odoo before doing anything else.'); }
  }
  private record(id: string) { const r = this.records().find(r => r.id === id); if (!r) return fail('Select an action from the live action log.'); return r; }
  private async target(id: string, uuid?: string) {
    const target = await this.browser.inspectLive(id); if (target.database.source !== 'odoo' || (uuid && uuid !== target.uuid)) fail('The database identity changed. No live action is permitted.');
    return target;
  }
  private async absent(name: string) {
    if ((await this.browser.liveList()).some(r => r.database.name.toLowerCase() === name.toLowerCase())) fail('That copy name already appears in your account. Choose a different name.');
  }
  private async missingCopy(record: LiveRecord) {
    const listed = await this.browser.liveList();
    if (!listed.some(row => row.uuid === record.originalUuid && row.database.id === record.original.id)) fail('The original identity is no longer present. The previous cycle must remain open.');
    if (listed.some(row => row.uuid === record.copyUuid || row.database.name.toLowerCase() === record.copyName.toLowerCase())) fail('The previous copy is still listed by name or identity. The previous cycle must remain open.');
  }
  private async availableCycle(uuid: string, name: string) {
    for (const record of this.records()) {
      if (record.copyName.toLowerCase() === name.toLowerCase()) fail('An action already exists for that copy name. Use a fresh name; historical names cannot be reused.');
      if (record.originalUuid !== uuid) continue;
      if (record.phase === 'copy-retained' && record.retainedAt && record.copyUuid) continue;
      if (record.phase !== 'copy-removed' || !record.removal?.userReportedRemoved || !record.copyUuid) fail('An action already exists for this source. Use its verification controls, or close the cycle if you manually removed its known copy.');
      // Recheck on preparation and submission, including after an app restart.
      await this.missingCopy(record);
    }
  }
  async retainCopy(id: string) {
    this.cancel(); this.assertReady();
    const record=this.record(z.string().uuid().parse(id));
    if(record.phase!=='copy-verified'||!record.copyUuid||!record.verifiedAt)fail('Verify the copy before closing its cycle and keeping both databases.');
    const original=await this.target(record.original.id,record.originalUuid);
    const copy=await this.checkedCopy(record),now=new Date().toISOString();
    await this.put(withProgress({...record,original:original.database,copy:copy.database,phase:'copy-retained',retainedAt:now,updatedAt:now,
      message:'Cycle closed with both databases retained. No deletion was requested. This record cannot resume lifecycle actions; a new copy requires a fresh name and its own creation review.'},'retained','done','Deletion skipped. The original and verified copy are retained.'));
  }
  async closeRemovedCopy(input: { recordId: string; removedByUser: true }) {
    this.cancel(); this.assertReady();
    const parsed = z.object({recordId:z.string().uuid(),removedByUser:z.literal(true)}).strict().parse(input);
    const record = this.record(parsed.recordId);
    if (!record.copyUuid || !['activation-pending','awaiting-expiry','copy-verified'].includes(record.phase)) fail('Only a known copy can be closed after manual removal. Uncertain creation or deletion outcomes remain locked.');
    await this.target(record.original.id, record.originalUuid);
    await this.missingCopy(record);
    const now = new Date().toISOString();
    await this.put({...record, phase:'copy-removed', verifiedAt:null, updatedAt:now,
      removal:{userReportedRemoved:true,checkedAt:now,previousPhase:record.phase as 'activation-pending'|'awaiting-expiry'|'copy-verified'},
      message:'Cycle closed after user-reported copy removal. The original identity was verified and the copy was absent by name and UUID from the visible account list. This is not independent proof of deletion. History is retained; a new cycle needs a fresh name and confirmation.'});
  }
  private issue(action: LiveReview['action'], target: LiveInspection, copyName: string, record: LiveRecord | null, workflow?:LiveRecord['workflow']): LiveReview {
    const review: LiveReview = { ticket: crypto.randomUUID(), expiresAt: new Date(Date.now() + TTL).toISOString(), action, original: target.database, copyName, copy: record?.copy ?? null, recordId: record?.id ?? null, ...(record?.scheduledId?{scheduledId:record.scheduledId}:{}), ...(workflow??record?.workflow?{workflow:workflow??record?.workflow}:{}) };
    if(action==='duplicate'&&workflow)review.deleteOriginal=this.execution.deletionAllowed?.()===true;
    else if(record?.deleteOriginal!==undefined)review.deleteOriginal=record.deleteOriginal;
    this.ticket = { review, fingerprint: identityFingerprint(target), uuid: target.uuid, copyUuid: record?.copyUuid ?? null };
    return structuredClone(review);
  }
  async prepareDuplicate(databaseId: string, copyName: string, workflow?:LiveRecord['workflow'], binding?:{uuid:string;scheduledId:string}) {
    this.cancel(); this.assertReady();
    z.string().max(200).parse(databaseId); z.string().max(50).parse(copyName);
    assertCopyName(copyName, databaseId.replace('https://', '').replace('.odoo.com', ''));
    const target = await this.target(databaseId,binding?.uuid); assertCopyName(copyName, target.database.name);
    if (target.database.duplication === 'unavailable' || ['expired', 'suspended'].includes(target.database.status)) fail('Odoo currently reports that this database cannot be duplicated.');
    await this.availableCycle(target.uuid, copyName);
    await this.absent(copyName);
    await this.browser.checkCopyName(copyName,target.database.name);
    const review=this.issue('duplicate', target, copyName, null, workflow);
    if(binding){this.ticket!.review.scheduledId=binding.scheduledId;review.scheduledId=binding.scheduledId;}
    return review;
  }
  getRecord(id:string){return structuredClone(this.record(id));}
  async authorizeWorkflow(id:string,workflow:'guided'|'automatic',scheduledId?:string){
    this.cancel();this.assertReady();const record=this.record(id);
    if(!['duplicate-submitting','duplicate-unknown','awaiting-copy','activation-pending','awaiting-expiry','copy-verified'].includes(record.phase))fail('This cycle cannot be continued. Check its recorded outcome.');
    if(workflow==='automatic'&&!this.execution.automaticAllowed?.())fail('Safe mode is enabled. Automatic execution is unavailable.');
    await this.target(record.original.id,record.originalUuid);
    await this.put({...record,workflow,deleteOriginal:this.execution.deletionAllowed?.()===true,workflowStartedAt:new Date().toISOString(),...(scheduledId?{scheduledId}:{})});
  }
  private async copyIdentity(record: LiveRecord): Promise<LiveInspection> {
    const copy = await this.target(`https://${record.copyName}.odoo.com`, record.copyUuid ?? undefined);
    // Odoo duplicates can point to the family's root, not their immediate source.
    // Older logs did not retain this root, so verify it against the original now.
    const root = record.originalParentUuid === undefined ? (await this.target(record.original.id, record.originalUuid)).parentUuid : record.originalParentUuid;
    if (copy.uuid === record.originalUuid || copy.database.name !== record.copyName || !copy.parentUuid || !(copy.parentUuid === record.originalUuid || root && copy.parentUuid === root)) fail('The copy must have a distinct identity and match the original’s Odoo database family.');
    if (!copy.neutralized) fail('The copy must be neutralized for testing.');
    return copy;
  }
  private assertCopyExpiry(copy: LiveInspection, info: ActivationInfo) {
    const days=daysRemaining(copy.database.expiresAt,new Date())??copy.database.remainingDays;
    if(days==null||days<=0||!copy.database.expirationObservedAt)fail('Odoo confirms activation, but a positive Manage expiry is not yet verified. Deletion remains blocked.');
    const trialDays=daysRemaining(info.expiresAt??null,new Date());
    // A rendered day counter may round differently from an exact timestamp.
    if(trialDays!==null&&(trialDays<=0||Math.abs(trialDays-days)>1))fail('Odoo expiry sources disagree. Deletion remains blocked until they can be reconciled.');
  }
  private async checkedCopy(record: LiveRecord): Promise<LiveInspection> {
    if(record.activation?.completion==='pending')fail('Finish the saved activation handoff before verifying the copy or deleting its original.');
    const copy = await this.copyIdentity(record);
    const info=await this.browser.activation(copy);
    if (!info.activated) fail('The copy is pending email activation. Activate it before verifying expiry or preparing deletion.');
    this.assertCopyExpiry(copy,info);
    return copy;
  }
  async verifyCopy(id: string) {
    this.cancel(); this.assertReady(); let r = this.record(id);
    if (!['duplicate-submitting','duplicate-unknown','awaiting-copy','activation-pending','awaiting-expiry','copy-verified'].includes(r.phase)) fail('This action cannot verify a copy after deletion has started. Review its outcome in Odoo.');
    let observed: LiveRecord | undefined;
    try {
      const copy=await this.copyIdentity(r), now=new Date().toISOString();
      if(!r.copyReadyAt){
        r=withProgress({...r,copyReadyAt:now,copy:copy.database,copyUuid:copy.uuid},'duplicate-done','done');await this.put(r);
        r=withProgress(r,'created','done');await this.put(r);
      }
      const info=await this.browser.activation(copy);
      const days=daysRemaining(copy.database.expiresAt,new Date())??copy.database.remainingDays;
      const incomplete=r.activation?.completion==='pending';
      observed={...r,copyReadyAt:r.copyReadyAt??now,copy:copy.database,copyUuid:copy.uuid,phase:info.activated&&!incomplete?'awaiting-expiry':'activation-pending',activationVerifiedAt:info.activated&&!incomplete?now:null,activationExpiresAt:info.expiresAt??null,verifiedAt:null,updatedAt:now,message:incomplete?'The activation handoff is incomplete. Use Complete activation; deletion remains blocked.':info.activated?`Odoo confirms activation. Manage reports ${days==null?'unknown expiry':days+' days remaining'}. Positive expiry must be verified before deletion is available.`:'The copy is pending email activation. The original is retained and deletion is blocked.'};
      await this.put(observed);
      if(incomplete)fail('Finish the saved activation handoff before verifying the copy or deleting its original.');
      if(!info.activated)fail('The copy is pending email activation. Activate it before verifying expiry or preparing deletion.');
      if(!observed.progressEvents?.some(event=>event.step==='activation-done'&&event.status==='done')){
        observed=withProgress(observed,'activation-done','done');await this.put(observed);
      }
      observed=withProgress(observed,'verifying','running');await this.put(observed);
      this.assertCopyExpiry(copy,info);
      await this.put(withProgress({...observed,phase:'copy-verified',verifiedAt:now,message:'Distinct copy, Odoo database family, authenticated access, testing neutralization, completed activation and actual expiry verified. Review your business data and backup before deleting the original.'},'verifying','done'));
      return r.id;
    } catch(error) {
      if(!observed)await this.put({...r,phase:r.phase==='duplicate-unknown'?'duplicate-unknown':'awaiting-copy',verifiedAt:null,updatedAt:new Date().toISOString(),message:'Copy verification did not pass. No deletion is allowed. Complete activation and recheck the Manage expiry.'});
      throw error;
    }
  }
  async startActivation(id: string) {
    this.cancel(); this.assertReady(); let r = this.record(id);
    if (!['duplicate-submitting','duplicate-unknown','awaiting-copy','activation-pending','awaiting-expiry','copy-verified'].includes(r.phase)) fail('Activation is unavailable after deletion has started.');
    const copy = await this.copyIdentity(r);
    if(!r.copyReadyAt){
      r=withProgress({...r,copyReadyAt:new Date().toISOString(),copy:copy.database,copyUuid:copy.uuid},'duplicate-done','done');await this.put(r);
      r=withProgress(r,'created','done');await this.put(r);
    }
    const info = await this.browser.activation(copy);
    if(r.activation?.completion==='pending')return structuredClone(r);
    if (info.activated) { await this.verifyCopy(id); return null; }
    if (!info.pending) fail('Odoo returned an unsupported activation status. Inspect this copy in Odoo.');
    if (r.activation && !sameEmail(r.activation.userEmail, info.userEmail)) fail('The signed-in Odoo user changed. Sign back into the user who started activation.');
    r = {...r, copyReadyAt:r.copyReadyAt??new Date().toISOString(), copy:copy.database, copyUuid:copy.uuid, phase:'activation-pending', verifiedAt:null, updatedAt:new Date().toISOString(), activation:r.activation ?? {userEmail:info.userEmail,recipientEmail:info.recipientEmail,send:'not-needed',sentAt:null,link:'not-started'},message:`Activation pending for ${info.userEmail}. The original is retained and deletion is blocked.`};
    r=withProgress(r,r.activation?.link==='not-started'?'waiting-email':'activating',r.activation?.link==='not-started'?'waiting':'running');
    await this.put(r);
    if (!sameEmail(info.recipientEmail,info.userEmail) && r.activation!.send === 'not-needed') {
      await this.approveStep('send-activation',r,info.userEmail);
      r={...r,activation:{...r.activation!,send:'sending',sentAt:new Date().toISOString()}};
      await this.put(r); // Durable intent prevents duplicate sends across restarts.
      try { this.execution.beforeMutation?.(); await this.browser.sendActivation(copy,info.userEmail); }
      catch { await this.put({...r,activation:{...r.activation!,send:'unknown'},message:'Activation email outcome is uncertain. Check the signed-in user’s mailbox. No automatic resend will occur.'}); throw new AppError('ACTIVATION_SEND_UNKNOWN','The email send was not confirmed. Open webmail and check for the activation email; it will not be resent automatically.'); }
      r={...r,activation:{...r.activation!,send:'sent',sentAt:new Date().toISOString()},message:`Odoo confirmed an activation email for ${info.userEmail}. Sign into that mailbox to activate this copy.`};
      await this.put(r);
    }
    return structuredClone(r);
  }
  activationEmailWaitMs(id: string) {
    return activationEmailWaitMs(this.record(id), this.execution.activationEmailDelayMinutes?.() ?? 3);
  }
  async completeActivation(id: string, readLink: (r: LiveRecord) => Promise<string>) {
    this.cancel();this.assertReady();let r=this.record(id);
    if(r.phase!=='activation-pending'||!r.activation)fail('Start activation for this tracked copy first.');
    const copy=await this.copyIdentity(r), info=await this.browser.activation(copy);
    if(r.activation.completion==='pending'){
      if(!sameEmail(info.userEmail,r.activation.userEmail))fail('The signed-in user changed. No activation handoff was opened.');
      await this.approveStep('resume-activation',r,info.userEmail);
      r=withProgress(r,'activating','running');await this.put(r);
      try{this.execution.beforeMutation?.();await this.browser.resumeActivation(copy,info.userEmail);}
      catch(error){await this.put(withProgress({...r,message:'The activation handoff is incomplete. No activation request was replayed; deletion remains blocked.'},'activating','uncertain','The activation handoff is incomplete. Use Complete activation to reconcile it.'));throw error;}
      await this.put({...r,activation:{...r.activation!,link:'opened',completion:'complete'},message:'Odoo’s activation completion page was confirmed. Reading expiry.'});
      await this.verifyCopy(id);return;
    }
    if(info.activated){await this.verifyCopy(id);return;}
    if(!info.pending||!sameEmail(info.userEmail,r.activation.userEmail))fail('Activation status or the signed-in user changed. No mailbox was read.');
    if(r.activation.link!=='not-started')fail('An activation link was already attempted. Use Verify copy; the link will not be replayed automatically.');
    const remaining = this.activationEmailWaitMs(id);
    if (!Number.isFinite(remaining)) fail('The activation email wait timestamp is invalid. Inspect this copy manually.');
    if (remaining > 0) throw new AppError('ACTIVATION_EMAIL_WAITING', `Waiting ${waitLabel(remaining)} before checking for the activation email. The original is retained.`);
    r=withProgress(r,'waiting-email','running','Checking Viamail for the activation link.');await this.put(r);
    const link=await readLink(structuredClone(r));
    activationURL(link,r.copyName,info.userEmail); // Reject unsupported formats before recording intent.
    r=withProgress(r,'email-received','done');await this.put(r);
    await this.approveStep('activate',r,info.userEmail);
    const intent=withProgress({...r,activation:{...r.activation!,link:'opening' as const,completion:'pending' as const},updatedAt:new Date().toISOString()},'activating','running');
    await this.put(intent);
    try{this.execution.beforeMutation?.();await this.browser.activateFromEmail(copy,link);}
    catch(error){await this.put(withProgress({...intent,activation:{...intent.activation!,link:'unknown'},message:'The activation handoff is incomplete. Use Complete activation to continue a saved, unsubmitted step. No completed request is replayed; deletion remains blocked.'},'activating','uncertain','Activation was not confirmed. Continue the saved handoff; no request is replayed.'));throw error instanceof AppError?error:new AppError('ACTIVATION_UNKNOWN','Activation was not confirmed. No request will be replayed.');}
    await this.put({...intent,activation:{...intent.activation!,link:'opened',completion:'complete'},message:'Odoo’s activation completion page was confirmed. Reading the copy’s activation status and Manage expiry.'});
    await this.verifyCopy(id);
  }
  async prepareDelete(id: string) {
    this.cancel(); this.assertReady(); let r = this.record(id);
    if (!this.canDeleteOriginal(id)) fail('Deletion is disabled for this lifecycle. Keep both databases.');
    if (r.phase !== 'copy-verified' || !r.copyUuid || !r.verifiedAt) fail('Verify the copy before preparing deletion.');
    r=withProgress(r,'awaiting-deletion','waiting');await this.put(r);
    const original = await this.target(r.original.id, r.originalUuid);
    if (original.database.deletion === 'unavailable') fail('Odoo reports that the deletion control is unavailable.');
    const copy = await this.checkedCopy(r);
    const refreshed = { ...r, deleteOriginal:true, original: original.database, copy: copy.database, verifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.put(refreshed);
    return this.issue('delete', original, r.copyName, refreshed);
  }
  async commit(input: LiveConfirmation) {
    this.assertReady(); const pending = this.ticket; this.ticket = null;
    const parsed = confirmation.safeParse(input);
    if (!parsed.success || !pending || parsed.data.ticket !== pending.review.ticket || Date.now() > Date.parse(pending.review.expiresAt)) fail('This confirmation is invalid, used or expired. Prepare a new review.');
    const data = parsed.data, review = pending.review;
    if (data.typedName !== review.original.name) fail('Type the original database name exactly.');
    if (review.action === 'delete' && (!data.backupConfirmed || !data.backupReference || data.backupReference.length < 5 || !data.integrityConfirmed || !data.integrityNotes || data.integrityNotes.length < 10 || !data.subscriptionReviewed)) fail('Confirm a recoverable backup, record your integrity checks, and review the subscription consequences.');
    return this.submit(pending,data,false);
  }
  // Main-process runner only. No IPC exposes this path or accepts an automatic flag.
  async commitAutomatic(ticket:string){
    this.assertReady();const pending=this.ticket;this.ticket=null;
    if(!pending||pending.review.ticket!==ticket||pending.review.workflow!=='automatic'||Date.now()>Date.parse(pending.review.expiresAt)||!this.execution.automaticAllowed?.())fail('Automatic execution is not authorized for this review.');
    return this.submit(pending,null,true);
  }
  private async submit(pending:Ticket,data:LiveConfirmation|null,automatic:boolean){
    const review=pending.review;
    const target = await this.target(review.original.id, pending.uuid);
    if (identityFingerprint(target) !== pending.fingerprint) fail('Database identity or subscription changed. Prepare a new review.');
    let record: LiveRecord;
    if (review.action === 'duplicate') {
      await this.availableCycle(target.uuid, review.copyName);
      assertCopyName(review.copyName, target.database.name); await this.absent(review.copyName);
      await this.browser.checkCopyName(review.copyName,target.database.name);
      if (target.database.duplication === 'unavailable' || ['expired','suspended'].includes(target.database.status)) fail('Duplication eligibility changed. Prepare a new review.');
      record = { id: crypto.randomUUID(), activationEmailDelayMinutes:this.execution.activationEmailDelayMinutes?.()??3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), original: target.database, originalUuid: target.uuid, originalParentUuid: target.parentUuid, ...(review.workflow?{workflow:review.workflow,deleteOriginal:review.deleteOriginal===true,workflowStartedAt:new Date().toISOString()}:{}), ...(review.scheduledId?{scheduledId:review.scheduledId}:{}), copyName: review.copyName, phase: 'duplicate-submitting', copy: null, copyUuid: null, verifiedAt: null, backupReference: null, integrityNotes: null, message: 'Duplication submission started. Never retry automatically; verify the copy after completion.' };
    } else {
      record = this.record(review.recordId!);
      if(!this.canDeleteOriginal(record.id))fail('Deletion is disabled for this lifecycle. Keep both databases.');
      if (record.phase !== 'copy-verified' || record.copyUuid !== pending.copyUuid || target.database.deletion === 'unavailable') fail('The deletion prerequisites changed. Prepare a new review.');
      await this.checkedCopy(record);
      if(automatic&&record.workflow!=='automatic')fail('This record has not been authorized for automatic completion.');
      record = { ...record, phase: 'delete-submitting', updatedAt: new Date().toISOString(), backupReference: automatic?null:data!.backupReference!, integrityNotes: automatic?null:data!.integrityNotes!, message: automatic?'Deletion started with Safe mode off after copy verification. No manual backup or business-integrity attestation was supplied. No retry is allowed.':'Deletion started with separate confirmation. Both the subscription and database may be affected. No automatic retry is allowed.' };
    }
    // Main-process native dialog defaults to Cancel. No request is sent before it.
    if (!automatic&&!await this.confirm(review)) return;
    if (Date.now() > Date.parse(review.expiresAt)) fail('The review expired while awaiting confirmation. Prepare it again.');
    if(automatic&&!this.execution.automaticAllowed?.())fail('Safe mode is enabled. Automatic execution stopped.');
    this.execution.beforeMutation?.();
    if(review.action==='delete'&&!this.canDeleteOriginal(record.id))fail('Deletion is disabled for this lifecycle.');
    record=withProgress(record,review.action==='duplicate'?'duplicating':'deleting','running');
    await this.put(record); // Write intent before any mutation; crash/restart cannot replay.
    try {
      this.execution.beforeMutation?.();
      if (review.action === 'duplicate') {
        await this.browser.duplicateLive(target, review.copyName);
        await this.put({ ...record, phase: 'awaiting-copy', updatedAt: new Date().toISOString(), message: 'Odoo accepted duplication. Wait for it to finish, then use Verify copy. The original has not been deleted.' });
      } else {
        if(!this.canDeleteOriginal(record.id))fail('Deletion is disabled for this lifecycle.');
        await this.browser.deleteLive(target);
        const listed = await this.browser.liveList();
        if (listed.some(r => r.uuid === record.originalUuid || r.database.id === record.original.id)) throw new AppError('LIVE_OUTCOME_UNKNOWN', 'Odoo acknowledged deletion but the original is still listed. Verify in Odoo; do not retry.');
        await this.put(withProgress({ ...record, phase: 'deleted', updatedAt: new Date().toISOString(), message: 'Odoo acknowledged both deletion steps and the original is absent from the refreshed account list. The verified copy is retained.' },'deleted','done'));
      }
      return record.id;
    } catch {
      await this.put(withProgress({ ...record, phase: review.action === 'duplicate' ? 'duplicate-unknown' : 'delete-unknown', updatedAt: new Date().toISOString(), message: review.action === 'duplicate' ? 'Duplication outcome is uncertain. Use Verify copy; do not resubmit.' : 'Deletion outcome is uncertain and may be partial, including subscription closure. Inspect Odoo manually. This app will not retry deletion.' },review.action==='duplicate'?'duplicating':'deleting','uncertain','The request may have completed. Verify the recorded outcome; do not submit it again.'));
      if(review.action==='duplicate'&&review.workflow)return record.id; // The runner may only reconcile through reads, never resubmit.
      throw new AppError('LIVE_OUTCOME_UNKNOWN', 'The live outcome is uncertain. Check the action log. No automatic retry will occur.');
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppService, type ReadOnlyConnection, type MailConnection } from '../electron/service';
import type { LiveConnection } from '../electron/live-service';
import type { LiveInspection } from '../electron/live-contract';
import { LocalStore } from '../electron/store';
import { AppError } from '../electron/errors';
import { scheduledCandidates } from '../src/domain/lifecycle-schedule';
import { DEFAULT_SETTINGS } from '../src/domain/demo';
const PROTECTED_DATABASE = 'example-accounting-0805';
import type { LiveConfirmation, LiveRecord, LiveReview } from '../src/shared/live';
const uuid='11111111-1111-4111-8111-111111111111',copyUuid='22222222-2222-4222-8222-222222222222';
function target(name='fixture',id=uuid,parentUuid:string|null=null):LiveInspection{
 return {database:{uuid:id,id:`https://${name}.odoo.com`,url:`https://${name}.odoo.com`,name,source:'odoo',version:'19',createdAt:null,expiresAt:null,remainingDays:2,expirationObservedAt:new Date().toISOString(),expirationEvidence:'Manage countdown',status:'trial',designation:'testing',subscription:'none',duplication:'available',deletion:'available',restrictions:[],observedAt:new Date().toISOString()},uuid:id,parentUuid,neutralized:true,token:'fixture-token',accessToken:false,subId:false,isPaid:false,plan:'Trial'};
}
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.useRealTimers();});
async function setup(deleteAfterActivation=true){
 vi.useFakeTimers({toFake:['Date']});
 const dir=await mkdtemp(join(tmpdir(),'lifecycle-workflow-')),store=new LocalStore(join(dir,'data'));
 let original=target(),copy=target('fixture-copy',copyUuid,uuid),created=false,deleted=false,activated=true;
 const rows=()=>[...(!deleted?[{database:original.database,uuid:original.uuid,parentUuid:null}]:[]),...(created?[{database:copy.database,uuid:copy.uuid,parentUuid:uuid}]:[])];
 const discovery=()=>({source:'odoo' as const,databases:rows().map(row=>({...row.database,observedAt:new Date().toISOString(),expirationObservedAt:new Date().toISOString()})),refreshedAt:new Date().toISOString(),coverage:'visible-list' as const,pages:1,warnings:[]});
 const browser:ReadOnlyConnection&LiveConnection={connect:vi.fn(async()=>discovery()),refresh:vi.fn(async()=>discovery()),close:vi.fn(async()=>{}),checkCopyName:vi.fn(async()=>{}),liveList:vi.fn(async()=>rows()),inspectLive:vi.fn(async id=>{if(id===original.database.id&&!deleted)return structuredClone(original);if(id===copy.database.id&&created)return structuredClone(copy);throw new AppError('DATABASE_MISSING','Copy not ready');}),duplicateLive:vi.fn(async(_source,name)=>{copy=target(name,copyUuid,uuid);created=true;}),deleteLive:vi.fn(async()=>{deleted=true;}),activation:vi.fn(async()=>({pending:!activated,activated,userEmail:'current@example.com',recipientEmail:'old@example.com',expiresAt:new Date(Date.now()+2*86400000).toISOString()})),sendActivation:vi.fn(async()=>{}),resumeActivation:vi.fn(async()=>{}),activateFromEmail:vi.fn(async()=>{activated=true;})};
 const mail:MailConnection={connect:vi.fn(async()=>'current@example.com'),finishLogin:vi.fn(),check:vi.fn(async()=>'current@example.com'),close:vi.fn(async()=>{}),setHeadless:vi.fn(async()=>{}),findActivationLink:vi.fn(async t=>`https://www.odoo.com/odoo-enterprise/confirm-database/${t.copyName}/${'a'.repeat(40)}?email=current%40example.com&username=current%40example.com&country_id=38`)};
 const confirm=vi.fn(async()=>true),confirmAutomatic=vi.fn(async()=>true),wait=vi.fn(async(_signal:AbortSignal)=>{vi.setSystemTime(Date.now()+15_000);});
 const createService=()=>new AppService(store,join(dir,'profile'),'unused',()=>{},browser,confirm,{mailbox:mail,confirmAutomatic,runnerWait:wait});
 const service=createService();await service.initialize();await service.connect();await service.saveSettings({...service.getState().settings,deleteAfterActivation});
 cleanups.push(async()=>{await service.dispose();await rm(dir,{recursive:true,force:true});});
 return {service,store,browser,mail,confirm,confirmAutomatic,wait,createService,original:()=>original,copy:()=>copy,setOriginal:(x:LiveInspection)=>{original=x;},setCopy:(x:LiveInspection)=>{copy=x;},pendingActivation:()=>{activated=false;},setCreated:(value:boolean)=>{created=value;}};
}
function confirmation(review:LiveReview):LiveConfirmation{return {ticket:review.ticket,typedName:'fixture',acknowledged:true,...(review.action==='delete'?{backupConfirmed:true,backupReference:'Verified offline backup',integrityConfirmed:true,integrityNotes:'Checked orders and attachments',subscriptionReviewed:true}:{})};}
describe('Safe mode and automatic lifecycle',()=>{
 it('defaults to Safe mode and requires two independent native confirmations',async()=>{
  const f=await setup();expect(f.service.getState().lifecyclePreferences.safeMode).toBe(true);
  const review=await f.service.runLifecycle(f.original().database.id,'fixture-copy');expect(review?.action).toBe('duplicate');expect(f.browser.duplicateLive).not.toHaveBeenCalled();
  const deletion=await f.service.confirmLive(confirmation(review!));expect(deletion?.action).toBe('delete');expect(f.confirm).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).not.toHaveBeenCalled();
  await f.service.confirmLive(confirmation(deletion!));expect(f.confirm).toHaveBeenCalledTimes(2);expect(f.service.getState().liveHistory[0].phase).toBe('deleted');
 });
 it('turning Safe mode off needs explicit mode approval, starts nothing, and persists',async()=>{
  const f=await setup();f.confirmAutomatic.mockResolvedValueOnce(false);await f.service.saveLifecyclePreferences({safeMode:false});expect(f.service.getState().lifecyclePreferences.safeMode).toBe(true);
  await f.service.saveLifecyclePreferences({safeMode:false});expect(f.browser.duplicateLive).not.toHaveBeenCalled();expect(f.browser.deleteLive).not.toHaveBeenCalled();
  await f.service.dispose();const restored=f.createService();await restored.initialize();expect(restored.getState().lifecyclePreferences.safeMode).toBe(false);expect(f.browser.deleteLive).not.toHaveBeenCalled();await restored.dispose();
 });
 it('automatically creates, activates via the matching mailbox, verifies and deletes once with inherited expiry',async()=>{
  const f=await setup();f.pendingActivation();await f.service.saveLifecyclePreferences({safeMode:false});
  await f.service.runLifecycle(f.original().database.id,'fixture-copy');
  expect(f.confirm).not.toHaveBeenCalled();expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.sendActivation).toHaveBeenCalledTimes(1);expect(f.mail.findActivationLink).toHaveBeenCalledTimes(1);expect(f.browser.activateFromEmail).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);
  expect(f.service.getState().liveHistory[0]).toMatchObject({phase:'deleted',workflow:'automatic',backupReference:null,integrityNotes:null,copy:{remainingDays:2}});
 });
 it('reconciles an uncertain creation through reads without ever submitting again',async()=>{
  const f=await setup();const duplicate=f.browser.duplicateLive;vi.mocked(duplicate).mockImplementation(async()=>{f.setCreated(true);throw new Error('timeout');});await f.service.saveLifecyclePreferences({safeMode:false});
  await f.service.runLifecycle(f.original().database.id,'fixture-copy');expect(duplicate).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);
 });
 it('waits for email delivery; never resends the activation request',async()=>{
  const f=await setup();f.pendingActivation();vi.mocked(f.mail.findActivationLink).mockRejectedValueOnce(new AppError('MAIL_NOT_ARRIVED','Delivery pending'));await f.service.saveLifecyclePreferences({safeMode:false});
  await f.service.runLifecycle(f.original().database.id,'fixture-copy');expect(f.wait).toHaveBeenCalled();expect(f.browser.sendActivation).toHaveBeenCalledTimes(1);expect(f.mail.findActivationLink).toHaveBeenCalledTimes(2);expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);
 });
 it('waits for provisioning through reads without duplicating twice',async()=>{
  const f=await setup(),duplicate=vi.mocked(f.browser.duplicateLive).getMockImplementation()!;
  vi.mocked(f.browser.duplicateLive).mockImplementation(async(...args)=>{await duplicate(...args);f.setCreated(false);});f.wait.mockImplementation(async()=>{f.setCreated(true);});
  await f.service.saveLifecyclePreferences({safeMode:false});await f.service.runLifecycle(f.original().database.id,'fixture-copy');expect(f.wait).toHaveBeenCalledTimes(1);expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);
 });
 it('Stop during expiry waiting prevents deletion and does not claim data integrity',async()=>{
  const f=await setup();const duplicate=vi.mocked(f.browser.duplicateLive).getMockImplementation()!;vi.mocked(f.browser.duplicateLive).mockImplementation(async(...args)=>{await duplicate(...args);f.setCopy({...f.copy(),database:{...f.copy().database,remainingDays:0}});});
  f.wait.mockImplementation(async()=>{await f.service.stopLifecycle();});await f.service.saveLifecyclePreferences({safeMode:false});
  await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow(/stopped/);expect(f.browser.deleteLive).not.toHaveBeenCalled();expect(f.service.getState().lifecycleRun).toMatchObject({active:false,progress:{status:'stopped'}});expect(f.service.getState().liveHistory[0].integrityNotes).toBeNull();
 });
 it('keeps uncertain deletion locked and does not auto-resume',async()=>{
  const f=await setup();await f.service.saveLifecyclePreferences({safeMode:false});vi.mocked(f.browser.deleteLive).mockRejectedValue(new Error('uncertain'));
  await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow(/uncertain/);const id=f.service.getState().liveHistory[0].id;
  await expect(f.service.continueLifecycle(id)).rejects.toThrow(/cannot be continued/);expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);
  await f.service.dispose();const restored=f.createService();await restored.initialize();expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);await restored.dispose();
 });
 it('blocks an unrelated copy even with Safe mode off',async()=>{
  const f=await setup();const duplicate=vi.mocked(f.browser.duplicateLive).getMockImplementation()!;
  vi.mocked(f.browser.duplicateLive).mockImplementation(async(...args)=>{await duplicate(...args);f.setCopy({...f.copy(),parentUuid:'33333333-3333-4333-8333-333333333333'});});
  await f.service.saveLifecyclePreferences({safeMode:false});await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow(/family/);expect(f.browser.deleteLive).not.toHaveBeenCalled();
 });
 it('leaves the parent when the separate deletion confirmation is cancelled',async()=>{
  const f=await setup(),create=await f.service.runLifecycle(f.original().database.id,'fixture-copy');const deletion=await f.service.confirmLive(confirmation(create!));
  f.confirm.mockResolvedValueOnce(false);await f.service.confirmLive(confirmation(deletion!));expect(f.browser.deleteLive).not.toHaveBeenCalled();expect(f.service.getState().liveHistory[0].phase).toBe('copy-verified');
 });
 it('navigation cannot invalidate an active automatic review, while Stop remains available',async()=>{
  const f=await setup();vi.mocked(f.browser.checkCopyName).mockImplementation(async()=>{await f.service.cancelLive();});await f.service.saveLifecyclePreferences({safeMode:false});
  await f.service.runLifecycle(f.original().database.id,'fixture-copy');expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);
 });
 it('bounds expiry polling and leaves a resumable record without repeating creation',async()=>{
  vi.useFakeTimers({toFake:['Date']});const f=await setup(),duplicate=vi.mocked(f.browser.duplicateLive).getMockImplementation()!;
  vi.mocked(f.browser.duplicateLive).mockImplementation(async(...args)=>{await duplicate(...args);f.setCopy({...f.copy(),database:{...f.copy().database,remainingDays:0}});});
  f.wait.mockImplementation(async()=>{vi.setSystemTime(Date.now()+16*60000);});await f.service.saveLifecyclePreferences({safeMode:false});
  await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow(/15 minutes/);expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).not.toHaveBeenCalled();expect(f.service.getState().liveHistory[0].phase).toBe('awaiting-expiry');
 });
 it('keeps accounting excluded in automatic mode',async()=>{
  const f=await setup();await f.service.saveLifecyclePreferences({safeMode:false});await expect(f.service.runLifecycle(`https://${PROTECTED_DATABASE}.odoo.com`,'fixture-copy')).rejects.toThrow(/accounting/);expect(f.browser.inspectLive).not.toHaveBeenCalled();expect(f.browser.duplicateLive).not.toHaveBeenCalled();
 });
});
describe('scheduled lifecycle rules',()=>{
 it('queues countdown matches with Safe mode on and never mutates before approval',async()=>{
  const f=await setup();await f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true});await f.service.runMonitor();
  expect(f.service.getState().lifecycleQueue).toHaveLength(1);expect(f.browser.duplicateLive).not.toHaveBeenCalled();await f.service.runMonitor();expect(f.service.getState().lifecycleQueue).toHaveLength(1);
  const review=await f.service.runScheduledLifecycle(f.service.getState().lifecycleQueue[0].id);expect(review?.action).toBe('duplicate');expect(f.browser.duplicateLive).not.toHaveBeenCalled();
  const deletion=await f.service.confirmLive(confirmation(review!));expect(f.service.getState().lifecycleQueue[0].status).toBe('pending');await f.service.confirmLive(confirmation(deletion!));expect(f.service.getState().lifecycleQueue[0].status).toBe('complete');
 });
 it('automatically handles selected databases, then does not loop on the inherited-expiry copy',async()=>{
  const f=await setup();await f.service.saveLifecyclePreferences({safeMode:false});await f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true,scope:'selected',databaseIds:[f.original().database.id]});
  await f.service.runMonitor();expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);expect(f.service.getState().lifecycleQueue[0].status).toBe('complete');
  expect(f.service.getState().settings.databaseIds).toEqual([f.copy().database.id]);
  await f.service.runMonitor();expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);
  await f.service.saveSettings({...f.service.getState().settings,scope:'all',databaseIds:[]});await f.service.runMonitor();expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);
 });
 it('Stop during an in-flight deletion prevents the next database from starting',async()=>{
  const f=await setup(),refresh=vi.mocked(f.browser.refresh).getMockImplementation()!,remove=vi.mocked(f.browser.deleteLive).getMockImplementation()!;
  vi.mocked(f.browser.refresh).mockImplementation(async()=>{const d=await refresh();return {...d,databases:[...d.databases,target('second-fixture','33333333-3333-4333-8333-333333333333').database]};});
  vi.mocked(f.browser.deleteLive).mockImplementation(async(...args)=>{await f.service.stopLifecycle();await remove(...args);});
  await f.service.saveLifecyclePreferences({safeMode:false});await f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true});await f.service.runMonitor();
  expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);expect(f.mail.check).toHaveBeenCalledTimes(1);expect(f.service.getState().lifecycleQueue.map(job=>job.status)).toEqual(['complete','pending']);
 });
 it('does not run a simulation-only rule live with Safe mode off',async()=>{
  const f=await setup();await f.service.saveLifecyclePreferences({safeMode:false});await f.service.runMonitor();expect(f.browser.duplicateLive).not.toHaveBeenCalled();expect(f.service.getState().lifecycleQueue).toHaveLength(0);
 });
 it('requires a nonempty selected scope and stops before changed scheduled identities',async()=>{
  const f=await setup();await expect(f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true,scope:'selected',databaseIds:[]})).rejects.toThrow(/Select/);
  await f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true});await f.service.runMonitor();const job=f.service.getState().lifecycleQueue[0];
  f.setOriginal({...f.original(),uuid:copyUuid});await expect(f.service.runScheduledLifecycle(job.id)).rejects.toThrow(/identity changed/);expect(f.browser.duplicateLive).not.toHaveBeenCalled();expect(f.service.getState().lifecycleQueue[0].status).toBe('attention');
 });
 it('pauses a scheduled job if the saved mailbox is unavailable',async()=>{
  const f=await setup();await f.service.saveLifecyclePreferences({safeMode:false});await f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true});
  vi.mocked(f.mail.check).mockRejectedValue(new AppError('MAIL_SESSION_EXPIRED','Sign in again'));await f.service.runMonitor();
  expect(f.service.getState().lifecycleQueue[0].status).toBe('attention');expect(f.browser.duplicateLive).not.toHaveBeenCalled();
  await f.service.runMonitor();expect(f.mail.check).toHaveBeenCalledTimes(1);
 });
 it('marks interrupted scheduled work for attention on restart instead of replaying it',async()=>{
  const f=await setup();await f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true});await f.service.runMonitor();await f.service.dispose();
  const {data}=await f.store.load();await f.store.save({...data,lifecycleQueue:data.lifecycleQueue.map(job=>({...job,status:'running'}))});
  const restored=f.createService();await restored.initialize();expect(restored.getState().lifecycleQueue[0].status).toBe('attention');expect(f.browser.duplicateLive).not.toHaveBeenCalled();await restored.dispose();
 });
 it('excludes accounting, stale readings and prior copy expiries; accepts a later expiry event',()=>{
  const db=target().database,settings={...DEFAULT_SETTINGS,lifecycleEnabled:true,thresholdDays:40};
  const protectedDb=target(PROTECTED_DATABASE).database,stale={...db,expirationObservedAt:new Date(Date.now()-3600000).toISOString()};
  expect(scheduledCandidates([protectedDb,stale],settings,[],[])).toHaveLength(0);
  const copy=target('fixture-copy',copyUuid,uuid).database;
  const record={original:db,copy,copyName:copy.name,copyUuid} as LiveRecord;
  expect(scheduledCandidates([copy],settings,[],[record])).toHaveLength(0);
  expect(scheduledCandidates([{...copy,remainingDays:31}],settings,[],[record])).toHaveLength(1);
 });
});

describe('workflow preferences in the lifecycle service',()=>{
 it('persists preferences without enabling, scheduling or starting a lifecycle',async()=>{
  const f=await setup(),before=f.service.getState();
  await f.service.saveWorkflowPreferences({activationEmailDelayMinutes:5,copyNameTemplate:'{name}-backup'});
  expect(f.service.getState().settings).toEqual(before.settings);expect(f.service.getState().lastAttemptAt).toBe(before.lastAttemptAt);
  await f.service.dispose();const restored=f.createService();await restored.initialize();
  expect(restored.getState().workflowPreferences).toEqual({activationEmailDelayMinutes:5,copyNameTemplate:'{name}-backup'});
  expect(f.browser.duplicateLive).not.toHaveBeenCalled();expect(f.browser.deleteLive).not.toHaveBeenCalled();await restored.dispose();
 });
 it('uses the template in simulations and newly scheduled jobs; keeps queued names fixed',async()=>{
  const f=await setup();await f.service.saveWorkflowPreferences({activationEmailDelayMinutes:3,copyNameTemplate:'{name}-backup'});
  await f.service.simulate([f.original().database.id]);expect(f.service.getState().history[0].proposedName).toBe('fixture-backup');
  await f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true});await f.service.runMonitor();
  expect(f.service.getState().lifecycleQueue[0].copyName).toBe('fixture-backup');
  await f.service.saveWorkflowPreferences({activationEmailDelayMinutes:0,copyNameTemplate:'{name}-new'});
  expect(f.service.getState().lifecycleQueue[0].copyName).toBe('fixture-backup');expect(f.browser.duplicateLive).not.toHaveBeenCalled();
 });
 it('honors a delivery delay longer than the polling timeout and sends only once',async()=>{
  const f=await setup();f.pendingActivation();await f.service.saveWorkflowPreferences({activationEmailDelayMinutes:60,copyNameTemplate:'{name}-copy'});
  await f.service.saveLifecyclePreferences({safeMode:false});const started=Date.now(),read=vi.mocked(f.mail.findActivationLink).getMockImplementation()!;
  vi.mocked(f.mail.findActivationLink).mockImplementation(async target=>{expect(Date.now()-started).toBeGreaterThanOrEqual(60*60_000);return read(target);});
  f.wait.mockImplementation(async()=>{vi.setSystemTime(Date.now()+10*60_000);});
  await f.service.runLifecycle(f.original().database.id,'fixture-copy');
  expect(f.browser.sendActivation).toHaveBeenCalledTimes(1);expect(f.mail.findActivationLink).toHaveBeenCalledTimes(1);expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);
 });
 it('Stop during the delivery wait prevents mailbox reading, activation and deletion',async()=>{
  const f=await setup();f.pendingActivation();await f.service.saveLifecyclePreferences({safeMode:false});
  f.wait.mockImplementation(async()=>{expect(f.service.getState().lifecycleRun?.stage).toMatch(/waiting for activation email \(3:00\)/);await f.service.stopLifecycle();});
  await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow(/stopped/);
  expect(f.mail.findActivationLink).not.toHaveBeenCalled();expect(f.browser.activateFromEmail).not.toHaveBeenCalled();expect(f.browser.deleteLive).not.toHaveBeenCalled();
 });
 it('rejects malformed preferences at the main-process boundary without overwriting saved settings',async()=>{
  const f=await setup(),before=f.service.getState().workflowPreferences;
  await expect(f.service.saveWorkflowPreferences({activationEmailDelayMinutes:61,copyNameTemplate:'{name}-copy'})).rejects.toThrow(/0 to 60/);
  await expect(f.service.saveWorkflowPreferences({activationEmailDelayMinutes:3,copyNameTemplate:'../unsafe'})).rejects.toThrow(/name/);
  expect(f.service.getState().workflowPreferences).toEqual(before);
 });
});

describe('optional parent deletion and lifecycle progress',()=>{
 it('runs an automatic rule through activation, keeps both databases, and suppresses repeat copies',async()=>{
  const f=await setup(false);f.pendingActivation();await f.service.saveLifecyclePreferences({safeMode:false});
  await f.service.saveSettings({...f.service.getState().settings,lifecycleEnabled:true});await f.service.runMonitor();
  const state=f.service.getState(),record=state.liveHistory[0];
  expect(record).toMatchObject({phase:'copy-retained',deleteOriginal:false,progress:{step:'retained',status:'done',percent:100}});
  expect(state.lifecycleRun).toMatchObject({active:false,progress:{step:'retained',percent:100}});
  expect(state.lifecycleQueue[0]).toMatchObject({status:'complete',message:expect.stringContaining('both databases retained')});
  expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.activateFromEmail).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).not.toHaveBeenCalled();
  expect(state.discovery!.databases.map(db=>db.name)).toContain('fixture');expect(state.discovery!.databases.map(db=>db.name)).toContain(record.copyName);
  expect(record.progressEvents?.filter(event=>event.status==='done').map(event=>event.step)).toEqual(expect.arrayContaining(['duplicate-done','created','email-received','activation-done','verifying','retained']));
  expect(record.progressEvents?.some(event=>['deleting','deleted'].includes(event.step))).toBe(false);
  await f.service.runMonitor();expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);
 });
 it('asks only for creation in Safe mode with deletion off; later enabling deletion cannot reopen this cycle',async()=>{
  const f=await setup(false),review=await f.service.runLifecycle(f.original().database.id,'fixture-copy');
  expect(review).toMatchObject({action:'duplicate',deleteOriginal:false});
  expect(await f.service.confirmLive(confirmation(review!))).toBeNull();expect(f.confirm).toHaveBeenCalledTimes(1);
  const record=f.service.getState().liveHistory[0];expect(record.phase).toBe('copy-retained');
  await f.service.saveSettings({...f.service.getState().settings,deleteAfterActivation:true});
  await expect(f.service.continueLifecycle(record.id)).rejects.toThrow(/cannot be continued/);
  await expect(f.service.prepareDelete(record.id)).rejects.toThrow(/disabled/);expect(f.browser.deleteLive).not.toHaveBeenCalled();
 });
 it('keeps copy-only policy across interruption, restart and an enabled deletion setting',async()=>{
  const f=await setup(false);f.pendingActivation();await f.service.saveLifecyclePreferences({safeMode:false});
  f.wait.mockImplementationOnce(async()=>{await f.service.stopLifecycle();});
  await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow(/stopped/);
  const id=f.service.getState().liveHistory[0].id;await f.service.dispose();
  const restored=f.createService();await restored.initialize();await restored.connect();
  await restored.saveSettings({...restored.getState().settings,deleteAfterActivation:true});
  await restored.continueLifecycle(id);expect(restored.getState().liveHistory[0]).toMatchObject({phase:'copy-retained',deleteOriginal:false});
  expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.sendActivation).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).not.toHaveBeenCalled();await restored.dispose();
 });
 it('turning deletion off invalidates an already prepared deletion review',async()=>{
  const f=await setup(),creation=await f.service.runLifecycle(f.original().database.id,'fixture-copy');
  const deletion=await f.service.confirmLive(confirmation(creation!));expect(deletion?.action).toBe('delete');
  await f.service.saveSettings({...f.service.getState().settings,deleteAfterActivation:false});
  await expect(f.service.confirmLive(confirmation(deletion!))).rejects.toThrow(/invalid, used/);
  await f.service.continueLifecycle(f.service.getState().liveHistory[0].id);
  expect(f.service.getState().liveHistory[0].phase).toBe('copy-retained');expect(f.browser.deleteLive).not.toHaveBeenCalled();
 });
 it('publishes named duplication and deletion stages before their requests and completion only after verification',async()=>{
  const f=await setup();f.pendingActivation();await f.service.saveLifecyclePreferences({safeMode:false});
  const duplicate=vi.mocked(f.browser.duplicateLive).getMockImplementation()!,remove=vi.mocked(f.browser.deleteLive).getMockImplementation()!,activate=vi.mocked(f.browser.activateFromEmail).getMockImplementation()!;
  vi.mocked(f.browser.duplicateLive).mockImplementation(async(...args)=>{expect(f.service.getState().lifecycleRun).toMatchObject({active:true,progress:{message:'Duplicating fixture',step:'duplicating'}});await duplicate(...args);});
  vi.mocked(f.browser.activateFromEmail).mockImplementation(async(...args)=>{expect(f.service.getState().lifecycleRun?.progress).toMatchObject({message:'Activating fixture-copy',step:'activating'});await activate(...args);});
  vi.mocked(f.browser.deleteLive).mockImplementation(async(...args)=>{expect(f.service.getState().lifecycleRun?.progress).toMatchObject({message:'Deleting fixture',step:'deleting',percent:90});await remove(...args);});
  await f.service.runLifecycle(f.original().database.id,'fixture-copy');const record=f.service.getState().liveHistory[0];
  expect(record.progress).toMatchObject({message:'fixture deleted',status:'done',percent:100});
  const messages=record.progressEvents!.map(event=>event.message);
  for(const message of ['Duplicating fixture','fixture duplication done','fixture-copy created','fixture-copy created, waiting for activation email','Activation email received for fixture-copy','Activating fixture-copy','fixture-copy activation done','Deleting fixture','fixture deleted'])expect(messages).toContain(message);
 });
 it('shows a failed email check at timeout without claiming receipt, activation, or deletion',async()=>{
  const f=await setup(false);f.pendingActivation();await f.service.saveLifecyclePreferences({safeMode:false});
  vi.mocked(f.mail.findActivationLink).mockRejectedValue(new AppError('MAIL_NOT_ARRIVED','Not delivered'));
  f.wait.mockImplementation(async()=>{vi.setSystemTime(Date.now()+5*60_000);});
  await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow(/15 minutes/);
  const record=f.service.getState().liveHistory[0];expect(record.progress).toMatchObject({step:'waiting-email',status:'failed',message:'Activation email check for fixture-copy unsuccessful'});
  expect(record.progressEvents?.some(event=>['email-received','activation-done','deleted','retained'].includes(event.step))).toBe(false);
  expect(f.browser.activateFromEmail).not.toHaveBeenCalled();expect(f.browser.deleteLive).not.toHaveBeenCalled();
  expect((await f.store.load()).data.liveHistory[0].progress).toEqual(record.progress);
 });
 it.each(['duplicate','activation','delete'])('keeps an uncertain %s outcome below 100 percent and never invents success',async kind=>{
  const f=await setup();f.pendingActivation();await f.service.saveLifecyclePreferences({safeMode:false});
  if(kind==='duplicate'){vi.mocked(f.browser.duplicateLive).mockRejectedValue(new Error('private request details'));f.wait.mockImplementation(async()=>{vi.setSystemTime(Date.now()+16*60_000);});}
  if(kind==='activation')vi.mocked(f.browser.activateFromEmail).mockRejectedValue(new Error('private request details'));
  if(kind==='delete')vi.mocked(f.browser.deleteLive).mockRejectedValue(new Error('private request details'));
  await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow();
  const record=f.service.getState().liveHistory[0];expect(record.progress?.status).toBe('uncertain');expect(record.progress!.percent).toBeLessThan(100);
  expect(record.progressEvents?.some(event=>event.step===(kind==='duplicate'?'created':kind==='activation'?'activation-done':'deleted')&&event.status==='done')).toBe(false);
  expect(JSON.stringify(record)).not.toContain('private request');
 });
 it('reports cancellation before submission and never sends a request',async()=>{
  const f=await setup(false),review=await f.service.runLifecycle(f.original().database.id,'fixture-copy');f.confirm.mockResolvedValueOnce(false);
  await f.service.confirmLive(confirmation(review!));expect(f.service.getState().lifecycleRun?.progress).toMatchObject({status:'stopped',detail:expect.stringContaining('cancelled before submission')});
  expect(f.service.getState().liveHistory).toEqual([]);expect(f.browser.duplicateLive).not.toHaveBeenCalled();
 });
 it('marks a persisted in-flight step interrupted on restart without resuming any database action',async()=>{
  const f=await setup(false),review=await f.service.prepareDuplicate(f.original().database.id,'fixture-copy');await f.service.confirmLive(confirmation(review));
  await f.service.dispose();const restored=f.createService();await restored.initialize();
  expect(restored.getState().liveHistory[0].progress).toMatchObject({status:'stopped',step:'duplicating'});expect(restored.getState().lifecycleRun).toBeNull();
  expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.activateFromEmail).not.toHaveBeenCalled();expect(f.browser.deleteLive).not.toHaveBeenCalled();await restored.dispose();
 });
});

describe('idle-only app update gate',()=>{
 it('blocks installation throughout duplication, email waiting, activation and deletion',async()=>{
  const f=await setup();f.pendingActivation();await f.service.connectMail();await f.service.saveLifecyclePreferences({safeMode:false});
  for(const method of ['duplicateLive','sendActivation','activateFromEmail','deleteLive'] as const){
   const original=vi.mocked(f.browser[method]).getMockImplementation()!;
   vi.mocked(f.browser[method]).mockImplementation((async(...args:any[])=>{
    expect(f.service.updateBlockReason()).toMatch(/finish/);expect(()=>f.service.acquireUpdateLock()).toThrow(/finish/);
    return (original as any)(...args);
   }) as any);
  }
  const wait=f.wait.getMockImplementation()!;
  f.wait.mockImplementation(async signal=>{expect(()=>f.service.acquireUpdateLock()).toThrow(/finish/);expect(signal.aborted).toBe(false);await wait(signal);});
  await f.service.runLifecycle(f.original().database.id,'fixture-copy');
  expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.activateFromEmail).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);
  expect(f.service.updateBlockReason()).toBeNull();expect(f.browser.close).not.toHaveBeenCalled();
 });
 it('blocks an idle review and a native confirmation, then permits updating after cancellation',async()=>{
  const f=await setup();const review=await f.service.runLifecycle(f.original().database.id,'fixture-copy');
  expect(f.service.getState().busy).toBe(false);expect(()=>f.service.acquireUpdateLock()).toThrow(/confirmation/);
  f.confirm.mockImplementation(async()=>{expect(()=>f.service.acquireUpdateLock()).toThrow(/finish/);return false;});
  await f.service.confirmLive(confirmation(review!));await f.service.cancelLive();expect(f.service.updateBlockReason()).toBeNull();
  f.service.acquireUpdateLock();await expect(f.service.runMonitor()).rejects.toThrow(/update/);await expect(f.service.runLifecycle(f.original().database.id,'fixture-copy')).rejects.toThrow(/update/);
  expect(f.browser.duplicateLive).not.toHaveBeenCalled();await f.service.closeForUpdate();expect(f.browser.close).toHaveBeenCalledTimes(1);
  f.service.releaseUpdateLock();expect(f.service.getState().busy).toBe(false);
 });
 it('cannot close provider sessions without acquiring the idle lock',async()=>{
  const f=await setup();await expect(f.service.closeForUpdate()).rejects.toThrow();expect(f.browser.close).not.toHaveBeenCalled();expect(f.mail.close).not.toHaveBeenCalled();
 });
});

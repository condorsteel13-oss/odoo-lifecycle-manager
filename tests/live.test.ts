import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveService, type LiveConnection } from '../electron/live-service';
import { identityFingerprint, parseLiveInspection, type LiveInspection } from '../electron/live-contract';
import type { LiveRecord } from '../src/shared/live';
import type { Database } from '../src/shared/types';
const PROTECTED_DATABASE = 'example-accounting-0805';
const uuid='11111111-1111-4111-8111-111111111111', copyUuid='22222222-2222-4222-8222-222222222222';
function target(name='fixture',id=uuid,parentUuid:string|null=null):LiveInspection {
 const database:Database={id:`https://${name}.odoo.com`,name,url:`https://${name}.odoo.com`,version:'19.0',createdAt:null,expiresAt:null,remainingDays:31,expirationObservedAt:new Date().toISOString(),expirationEvidence:'Trial banner',status:'trial',designation:'testing',subscription:'none',duplication:'available',deletion:'available',restrictions:[],observedAt:new Date().toISOString(),source:'odoo'};
 return {database,uuid:id,parentUuid,neutralized:true,token:'fixture-private-token',accessToken:false,subId:false,isPaid:false,plan:'Trial'};
}
function setup(){
 let records:LiveRecord[]=[];let original=target(),copy=target('fixture-copy',copyUuid,uuid);let hasCopy=false;
 const writes:string[]=[];
 const browser:LiveConnection={activation:vi.fn(async()=>({pending:false,activated:true,userEmail:'user@example.com',recipientEmail:'user@example.com'})),sendActivation:vi.fn(async()=>{}),activateFromEmail:vi.fn(async()=>{}),checkCopyName:vi.fn(async()=>{}),liveList:vi.fn(async()=>[{database:original.database,uuid,parentUuid:null},...(hasCopy?[{database:copy.database,uuid:copyUuid,parentUuid:uuid}]:[])]),inspectLive:vi.fn(async id=>structuredClone(id===original.database.id?original:copy)),duplicateLive:vi.fn(async()=>{writes.push('duplicate');hasCopy=true;}),deleteLive:vi.fn(async()=>{writes.push('delete');vi.mocked(browser.liveList).mockResolvedValue([{database:copy.database,uuid:copyUuid,parentUuid:uuid}]);})};
 const save=vi.fn(async(next:LiveRecord[])=>{writes.push(next[0].phase);records=structuredClone(next);});const confirm=vi.fn(async()=>true);
 const service=new LiveService(browser,()=>records,save,()=>true,confirm);
 const duplicate=async()=>{const review=await service.prepareDuplicate(original.database.id,'fixture-copy');await service.commit({ticket:review.ticket,typedName:'fixture',acknowledged:true});};
 const deletion=async()=>{const review=await service.prepareDelete(records[0].id);return {ticket:review.ticket,typedName:'fixture',acknowledged:true,backupConfirmed:true,backupReference:'Offline backup checked today',integrityConfirmed:true,integrityNotes:'Opened orders and attachments; totals checked.',subscriptionReviewed:true};};
 return {service,browser,save,confirm,writes,duplicate,deletion,records:()=>records,original,copy,setCopy:(value:LiveInspection)=>{copy=value;},setOriginal:(value:LiveInspection)=>{original=value;}};
}
afterEach(()=>vi.useRealTimers());
describe('manual live lifecycle safety boundary',()=>{
 it('preparation is read-only; duplicate and delete each need native confirmation and durable intent',async()=>{
  const f=setup();const review=await f.service.prepareDuplicate(f.original.database.id,'fixture-copy');
  expect(f.browser.duplicateLive).not.toHaveBeenCalled();expect(f.browser.deleteLive).not.toHaveBeenCalled();expect(f.records()).toEqual([]);
  expect(JSON.stringify(review)).not.toMatch(/private-token|accessToken/);
  await f.service.commit({ticket:review.ticket,typedName:'fixture',acknowledged:true});
  expect(f.writes).toEqual(['duplicate-submitting','duplicate','awaiting-copy']);expect(f.confirm).toHaveBeenCalledTimes(1);
  expect(f.browser.deleteLive).not.toHaveBeenCalled();await f.service.verifyCopy(f.records()[0].id);
  const input=await f.deletion();expect(f.browser.deleteLive).not.toHaveBeenCalled();await f.service.commit(input);
  expect(f.confirm).toHaveBeenCalledTimes(2);expect(f.records()[0].phase).toBe('deleted');
  expect(f.writes.indexOf('delete-submitting')).toBeLessThan(f.writes.indexOf('delete'));
  expect(JSON.stringify(f.records())).not.toMatch(/private-token|accessToken/);
 });
 it('native Cancel sends no mutation and consumes the ticket',async()=>{const f=setup();f.confirm.mockResolvedValue(false);const review=await f.service.prepareDuplicate(f.original.database.id,'fixture-copy');const input={ticket:review.ticket,typedName:'fixture',acknowledged:true};await f.service.commit(input);expect(f.records()).toEqual([]);expect(f.browser.duplicateLive).not.toHaveBeenCalled();await expect(f.service.commit(input)).rejects.toThrow(/invalid, used or expired/);});
 it.each(['wrong-name','unacknowledged','extra-param','expired','cancelled','restarted'])('rejects %s confirmations before any mutation',async kind=>{
  const f=setup();const review=await f.service.prepareDuplicate(f.original.database.id,'fixture-copy');let input:any={ticket:review.ticket,typedName:'fixture',acknowledged:true};
  if(kind==='wrong-name')input.typedName='fixture-copy';if(kind==='unacknowledged')input.acknowledged=false;if(kind==='extra-param')input.url='https://evil.example';
  if(kind==='expired'){vi.useFakeTimers();vi.setSystemTime(Date.now()+6*60000);}if(kind==='cancelled'||kind==='restarted')f.service.cancel();
  await expect(f.service.commit(input)).rejects.toThrow();expect(f.confirm).not.toHaveBeenCalled();expect(f.browser.duplicateLive).not.toHaveBeenCalled();
 });
 it('requires a real connected workspace',async()=>{const f=setup();const offline=new LiveService(f.browser,f.records,f.save,()=>false,f.confirm);await expect(offline.prepareDuplicate(f.original.database.id,'fixture-copy')).rejects.toThrow(/connected/);expect(f.browser.inspectLive).not.toHaveBeenCalled();});
 it('rejects accounting before network access',async()=>{const f=setup();await expect(f.service.prepareDuplicate(`https://${PROTECTED_DATABASE}.odoo.com`,'fixture-copy')).rejects.toThrow(/accounting/);expect(f.browser.inspectLive).not.toHaveBeenCalled();expect(f.browser.liveList).not.toHaveBeenCalled();});
 it.each(['fixture','BAD COPY','abc','a'.repeat(51),'edu-copy',PROTECTED_DATABASE])('rejects invalid or protected copy name %s',async name=>{const f=setup();await expect(f.service.prepareDuplicate(f.original.database.id,name)).rejects.toThrow();expect(f.browser.duplicateLive).not.toHaveBeenCalled();});
 it('blocks stale identities and changed subscriptions',async()=>{const f=setup();const review=await f.service.prepareDuplicate(f.original.database.id,'fixture-copy');f.setOriginal({...f.original,subId:33,isPaid:true,plan:'Custom'});await expect(f.service.commit({ticket:review.ticket,typedName:'fixture',acknowledged:true})).rejects.toThrow(/changed/);expect(f.confirm).not.toHaveBeenCalled();});
 it('prevents collision after review',async()=>{const f=setup();const review=await f.service.prepareDuplicate(f.original.database.id,'fixture-copy');vi.mocked(f.browser.liveList).mockResolvedValue([{database:f.copy.database,uuid:copyUuid,parentUuid:uuid}]);await expect(f.service.commit({ticket:review.ticket,typedName:'fixture',acknowledged:true})).rejects.toThrow(/already appears/);expect(f.browser.duplicateLive).not.toHaveBeenCalled();});
 it('never retries an uncertain duplicate, including after restart',async()=>{const f=setup();vi.mocked(f.browser.duplicateLive).mockRejectedValue(new Error('secret network diagnostic'));await expect(f.duplicate()).rejects.toThrow(/uncertain/);expect(f.records()[0].phase).toBe('duplicate-unknown');const restarted=new LiveService(f.browser,f.records,f.save,()=>true,f.confirm);await expect(restarted.prepareDuplicate(f.original.database.id,'fixture-new')).rejects.toThrow(/already exists/);expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(JSON.stringify(f.records())).not.toContain('secret');});
 it('blocks mutations when intent cannot be saved',async()=>{const f=setup();f.save.mockRejectedValue(new Error('disk full'));await expect(f.duplicate()).rejects.toThrow(/locked/);expect(f.browser.duplicateLive).not.toHaveBeenCalled();await expect(f.service.prepareDuplicate(f.original.database.id,'fixture-new')).rejects.toThrow(/intact/);});
 it.each(['identity','parent','neutralization','expiry','access'])('blocks deletion when copy %s verification fails',async kind=>{const f=setup();await f.duplicate();if(kind==='identity')f.setCopy({...f.copy,uuid});if(kind==='parent')f.setCopy({...f.copy,parentUuid:null});if(kind==='neutralization')f.setCopy({...f.copy,neutralized:false});if(kind==='expiry')f.setCopy({...f.copy,database:{...f.copy.database,remainingDays:null,expiresAt:null}});if(kind==='access')vi.mocked(f.browser.inspectLive).mockRejectedValue(new Error('access denied'));await expect(f.service.verifyCopy(f.records()[0].id)).rejects.toThrow();await expect(f.service.prepareDelete(f.records()[0].id)).rejects.toThrow(/Verify the copy/);expect(f.browser.deleteLive).not.toHaveBeenCalled();});
 it.each(['backupConfirmed','backupReference','integrityConfirmed','integrityNotes','subscriptionReviewed'])('requires deletion attestation %s in the main process',async key=>{const f=setup();await f.duplicate();await f.service.verifyCopy(f.records()[0].id);const input:any=await f.deletion();delete input[key];await expect(f.service.commit(input)).rejects.toThrow(/Confirm a recoverable/);expect(f.browser.deleteLive).not.toHaveBeenCalled();expect(f.confirm).toHaveBeenCalledTimes(1);});
 it('rechecks the copy after the deletion review',async()=>{const f=setup();await f.duplicate();await f.service.verifyCopy(f.records()[0].id);const input=await f.deletion();f.setCopy({...f.copy,neutralized:false});await expect(f.service.commit(input)).rejects.toThrow(/neutralized/);expect(f.browser.deleteLive).not.toHaveBeenCalled();});
 it('locks uncertain partial deletion against retries',async()=>{const f=setup();await f.duplicate();await f.service.verifyCopy(f.records()[0].id);const input=await f.deletion();vi.mocked(f.browser.deleteLive).mockRejectedValue(new Error('partial'));await expect(f.service.commit(input)).rejects.toThrow(/uncertain/);expect(f.records()[0].phase).toBe('delete-unknown');await expect(f.service.prepareDelete(f.records()[0].id)).rejects.toThrow();expect(f.browser.deleteLive).toHaveBeenCalledTimes(1);});
});

describe('Manage live metadata contract',()=>{
 const original=target();
 const props=()=>({subinfo:{db_name:'fixture',db_uuid:uuid,origin_url:'https://fixture.odoo.com',sub_plan:'Trial',expireIn:31,is_neutralized:true,token:'fixture-private-token',access_token:false,sub_id:false,scheme:'https',saas_url:'odoo.com',is_custom_domain:false},upgrade_info:{db:{db_name:'fixture',uuid,is_admin:true,upgradeQueued:false}}});
 const html=(p:unknown)=>`<owl-component name="openerp_enterprise.MyDatabaseInfo" props='${JSON.stringify(p)}'></owl-component>`;
 it('validates identity and extracts credentials only into the internal transport object',()=>{const result=parseLiveInspection(original.database,uuid,null,html(props()));expect(result.neutralized).toBe(true);expect(JSON.stringify(result.database)).not.toContain('private-token');expect(identityFingerprint(result)).not.toContain('private-token');});
 it.each(['identity','admin','upgrade','domain','token','subscription'])('fails closed for invalid %s',kind=>{const p=props();if(kind==='identity')p.upgrade_info.db.uuid=copyUuid;if(kind==='admin')p.upgrade_info.db.is_admin=false;if(kind==='upgrade')p.upgrade_info.db.upgradeQueued=true;if(kind==='domain')p.subinfo.saas_url='evil.example';if(kind==='token')p.subinfo.token='bad token';if(kind==='subscription')(p.subinfo as any).sub_id='unknown';expect(()=>parseLiveInspection(original.database,uuid,null,html(p))).toThrow();});
});


describe('activation lifecycle safeguards',()=>{
 const pending={pending:true,activated:false,userEmail:'current@example.com',recipientEmail:'previous@example.com'};
 it('sends once to the current user when the recipient differs, including across restarts',async()=>{const f=setup();await f.duplicate();vi.mocked(f.browser.activation).mockResolvedValue(pending);const id=f.records()[0].id;await f.service.startActivation(id);expect(f.browser.sendActivation).toHaveBeenCalledWith(expect.anything(),'current@example.com');expect(f.records()[0].activation?.send).toBe('sent');expect(f.records()[0].phase).toBe('activation-pending');const restarted=new LiveService(f.browser,f.records,f.save,()=>true,f.confirm);await restarted.startActivation(id);expect(f.browser.sendActivation).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).not.toHaveBeenCalled();});
 it('does not resend when Odoo already reports the logged-in user as recipient',async()=>{const f=setup();await f.duplicate();vi.mocked(f.browser.activation).mockResolvedValue({...pending,recipientEmail:'CURRENT@example.com'});await f.service.startActivation(f.records()[0].id);expect(f.browser.sendActivation).not.toHaveBeenCalled();});
 it('records uncertain email send and never retries',async()=>{const f=setup();await f.duplicate();vi.mocked(f.browser.activation).mockResolvedValue(pending);vi.mocked(f.browser.sendActivation).mockRejectedValue(new Error('timeout'));await expect(f.service.startActivation(f.records()[0].id)).rejects.toThrow(/not confirmed/);await f.service.startActivation(f.records()[0].id);expect(f.browser.sendActivation).toHaveBeenCalledTimes(1);expect(f.records()[0].activation?.send).toBe('unknown');});
 it('does not send when durable intent cannot be saved',async()=>{const f=setup();await f.duplicate();vi.mocked(f.browser.activation).mockResolvedValue(pending);f.save.mockRejectedValue(new Error('full'));await expect(f.service.startActivation(f.records()[0].id)).rejects.toThrow();expect(f.browser.sendActivation).not.toHaveBeenCalled();});
 it('keeps verification read-only and deletion blocked while activation is pending',async()=>{const f=setup();await f.duplicate();vi.mocked(f.browser.activation).mockResolvedValue(pending);await expect(f.service.verifyCopy(f.records()[0].id)).rejects.toThrow(/activation/);expect(f.browser.sendActivation).not.toHaveBeenCalled();await expect(f.service.prepareDelete(f.records()[0].id)).rejects.toThrow();});
 it('blocks mailbox reads if the signed-in Odoo user changes',async()=>{const f=setup();await f.duplicate();vi.mocked(f.browser.activation).mockResolvedValue(pending);await f.service.startActivation(f.records()[0].id);vi.mocked(f.browser.activation).mockResolvedValue({...pending,userEmail:'other@example.com'});const read=vi.fn();await expect(f.service.completeActivation(f.records()[0].id,read)).rejects.toThrow(/user changed/);expect(read).not.toHaveBeenCalled();});
 it('accepts shared Odoo root lineage and still requires positive post-activation expiry',async()=>{const f=setup();f.setOriginal({...f.original,parentUuid:copyUuid});f.setCopy({...f.copy,parentUuid:copyUuid});await f.duplicate();await f.service.verifyCopy(f.records()[0].id);f.setCopy({...f.copy,parentUuid:copyUuid,database:{...f.copy.database,remainingDays:0}});await expect(f.service.verifyCopy(f.records()[0].id)).rejects.toThrow(/positive/);expect(f.records()[0].verifiedAt).toBeNull();});
});

it('records completed activation separately from an unverified zero-day expiry',async()=>{const f=setup();await f.duplicate();f.setCopy({...f.copy,database:{...f.copy.database,remainingDays:0}});await expect(f.service.verifyCopy(f.records()[0].id)).rejects.toThrow(/positive/);expect(f.records()[0]).toMatchObject({phase:'awaiting-expiry',copy:{remainingDays:0},verifiedAt:null});expect(f.records()[0].activationVerifiedAt).toBeTruthy();await expect(f.service.prepareDelete(f.records()[0].id)).rejects.toThrow();expect(f.browser.deleteLive).not.toHaveBeenCalled();});
it('persists the pending-activation copy without treating its temporary expiry as verification',async()=>{const f=setup();await f.duplicate();vi.mocked(f.browser.activation).mockResolvedValue({pending:true,activated:false,userEmail:'current@example.com',recipientEmail:'old@example.com'});await expect(f.service.verifyCopy(f.records()[0].id)).rejects.toThrow(/pending/);expect(f.records()[0]).toMatchObject({phase:'activation-pending',activationVerifiedAt:null,verifiedAt:null,copyUuid});expect(f.browser.sendActivation).not.toHaveBeenCalled();});

it('blocks deletion when positive Manage and trial-service expiries disagree',async()=>{const f=setup();await f.duplicate();vi.mocked(f.browser.activation).mockResolvedValue({pending:false,activated:true,userEmail:'current@example.com',recipientEmail:'current@example.com',expiresAt:new Date(Date.now()+3*86400000).toISOString()});await expect(f.service.verifyCopy(f.records()[0].id)).rejects.toThrow(/sources disagree/);expect(f.records()[0].phase).toBe('awaiting-expiry');await expect(f.service.prepareDelete(f.records()[0].id)).rejects.toThrow();});

describe('user-reported removal and a fresh cycle',()=>{
 async function knownCopy(){const f=setup();await f.duplicate();await f.service.verifyCopy(f.records()[0].id);return f;}
 function absentCopy(f:ReturnType<typeof setup>){vi.mocked(f.browser.liveList).mockResolvedValue([{database:f.original.database,uuid,parentUuid:null}]);}
 it('retains the old record and requires a fresh name and new confirmation after restart',async()=>{
  const f=await knownCopy(), before=structuredClone(f.records()[0]);absentCopy(f);
  await f.service.closeRemovedCopy({recordId:before.id,removedByUser:true});
  expect(f.records()[0]).toMatchObject({...before,phase:'copy-removed',verifiedAt:null,updatedAt:expect.any(String),message:expect.stringContaining('not independent proof'),removal:{userReportedRemoved:true,previousPhase:'copy-verified',checkedAt:expect.any(String)}});
  expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).not.toHaveBeenCalled();expect(f.browser.sendActivation).not.toHaveBeenCalled();
  const restarted=new LiveService(f.browser,f.records,f.save,()=>true,f.confirm);
  await expect(restarted.prepareDuplicate(f.original.database.id,'fixture-copy')).rejects.toThrow(/historical names/);
  const review=await restarted.prepareDuplicate(f.original.database.id,'fixture-copy-2');expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);
  await restarted.commit({ticket:review.ticket,typedName:'fixture',acknowledged:true});
  expect(f.confirm).toHaveBeenCalledTimes(2);expect(f.records()).toHaveLength(2);expect(f.records()[1].id).toBe(before.id);expect(f.records()[0].copyName).toBe('fixture-copy-2');
  await expect(restarted.prepareDelete(before.id)).rejects.toThrow(/Verify/);await expect(restarted.verifyCopy(before.id)).rejects.toThrow();await expect(restarted.startActivation(before.id)).rejects.toThrow();
 });
 it.each(['name','uuid'])('keeps the cycle open when the old copy is still listed by %s',async kind=>{
  const f=await knownCopy();vi.mocked(f.browser.liveList).mockResolvedValue([{database:f.original.database,uuid,parentUuid:null},{database:{...f.copy.database,name:kind==='uuid'?'renamed-copy':f.copy.database.name},uuid:kind==='uuid'?copyUuid:'33333333-3333-4333-8333-333333333333',parentUuid:uuid}]);
  await expect(f.service.closeRemovedCopy({recordId:f.records()[0].id,removedByUser:true})).rejects.toThrow(/still listed/);expect(f.records()[0].phase).toBe('copy-verified');
 });
 it('requires explicit removal input and the same original identity',async()=>{
  const f=await knownCopy();absentCopy(f);const input={recordId:f.records()[0].id,removedByUser:true as const};
  await expect(f.service.closeRemovedCopy({...input,removedByUser:false} as any)).rejects.toThrow();
  f.setOriginal({...f.original,uuid:copyUuid});await expect(f.service.closeRemovedCopy(input)).rejects.toThrow(/identity changed/);expect(f.records()[0].phase).toBe('copy-verified');
 });
 it.each(['duplicate-unknown','duplicate-submitting','awaiting-copy','delete-unknown','delete-submitting','deleted'] as const)('cannot close %s as a workaround for uncertain outcomes',async phase=>{
  const f=await knownCopy();await f.save([{...f.records()[0],phase}]);absentCopy(f);vi.mocked(f.browser.inspectLive).mockClear();
  await expect(f.service.closeRemovedCopy({recordId:f.records()[0].id,removedByUser:true})).rejects.toThrow(/known copy/);expect(f.browser.inspectLive).not.toHaveBeenCalled();expect(f.records()[0].phase).toBe(phase);
 });
 it('invalidates an old deletion ticket and rechecks absence before new submission',async()=>{
  const f=await knownCopy();const deletion=await f.deletion();absentCopy(f);await f.service.closeRemovedCopy({recordId:f.records()[0].id,removedByUser:true});
  await expect(f.service.commit(deletion)).rejects.toThrow(/invalid, used/);
  const review=await f.service.prepareDuplicate(f.original.database.id,'fixture-copy-2');vi.mocked(f.browser.liveList).mockResolvedValue([{database:f.original.database,uuid,parentUuid:null},{database:f.copy.database,uuid:copyUuid,parentUuid:uuid}]);
  await expect(f.service.commit({ticket:review.ticket,typedName:'fixture',acknowledged:true})).rejects.toThrow(/still listed/);expect(f.browser.duplicateLive).toHaveBeenCalledTimes(1);expect(f.browser.deleteLive).not.toHaveBeenCalled();
 });
 it('does not unlock on a failed save or missing reconciliation evidence',async()=>{
  const f=await knownCopy();absentCopy(f);f.save.mockRejectedValueOnce(new Error('disk full'));
  await expect(f.service.closeRemovedCopy({recordId:f.records()[0].id,removedByUser:true})).rejects.toThrow(/locked/);
  await expect(f.service.prepareDuplicate(f.original.database.id,'fixture-new')).rejects.toThrow(/intact/);
  await f.save([{...f.records()[0],phase:'copy-removed'}]);const restarted=new LiveService(f.browser,f.records,f.save,()=>true,f.confirm);
  await expect(restarted.prepareDuplicate(f.original.database.id,'fixture-new')).rejects.toThrow(/already exists/);
 });
});

it('protects accounting names and URLs for every account',async()=>{
 const {isProtected}=await import('../src/shared/live');
 for(const name of ['accounting','example-accounting-0805','ACCOUNTING-PROD','https://company-accounting.odoo.com'])expect(isProtected(name)).toBe(true);
 for(const name of ['fixture','accountingtools','https://fixture.odoo.com'])expect(isProtected(name)).toBe(false);
});

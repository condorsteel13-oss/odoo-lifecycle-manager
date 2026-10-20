import {it,expect,vi} from 'vitest';
import {ActivationFlow,MemoryActivationJournal,activationCompletionURL,activationWorkerURL,type ActivationResponse} from '../electron/activation-flow';
const target={origin:'https://fixture.odoo.com',name:'fixture',uuid:'11111111-1111-4111-8111-111111111111',email:'user@example.com'};
const link='https://www.odoo.com/odoo-enterprise/confirm-database/fixture/'+('x'.repeat(140))+'?username=user%40example.com&email=user%40example.com&country_id=38';
const worker=target.origin+'/saas_worker/fixture_activation?db_uuid='+target.uuid+'&email=user%40example.com&signature=private-secret';
const completion='https://www.odoo.com/odoo-enterprise/invite-users?db_uuid='+target.uuid+'&login=user%40example.com&user_signature='+('s'.repeat(32));
const redirect=(url:string):ActivationResponse=>({status:303,location:url,body:'',contentType:'text/html'});
const success:ActivationResponse={status:200,location:null,contentType:'text/html',body:'<h1>Your database has been activated</h1><script>fetch("/delete")</script>'};
// The fake worker adapter lets these tests exercise checkpoint behavior without
// granting production access to an unobserved route.
const fixtureWorker=(url:string)=>{expect(url).toBe(worker);return new URL(url);};
it('binds the worker confirmation to the exact database and user and rejects extra operations',()=>{
 const good=target.origin+'/saas_worker/signin?'+new URLSearchParams({odoo_com_uid:'123',name:'Fixture User',email:target.email,action:'base.action_run_ir_action_todo',activate_freemium:'False',confirm_token:'t'.repeat(64),invite:'True',db_uuid:target.uuid});
 expect(activationWorkerURL(good,target).href).toBe(good);
 for(const bad of [good.replace('/signin','/drop/json'),good.replace('fixture.odoo.com','accounting.odoo.com'),good+'&db_uuid='+target.uuid,good+'&redirect=https://evil.example',good.replace('action=base.action_run_ir_action_todo','action=delete'),good.replace('email=user','email=other'),good.replace(target.uuid,'22222222-2222-4222-8222-222222222222')]){
  expect(()=>activationWorkerURL(bad,target)).toThrow();
 }
});
it('follows only the two handoffs and saves a token-free completed checkpoint',async()=>{
 const journal=new MemoryActivationJournal(),request=vi.fn().mockResolvedValueOnce(redirect(worker)).mockResolvedValueOnce(redirect(completion)).mockResolvedValueOnce(success),log=vi.fn();
 await new ActivationFlow(journal,request,log,fixtureWorker).run(target,link);
 expect(request.mock.calls.map(c=>c[0])).toEqual([link,worker,completion]);
 expect(await journal.read(target.uuid)).toMatchObject({stage:'complete',url:null});
 expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-secret|s{32}|user@example/);
 await new ActivationFlow(journal,request,log,fixtureWorker).run(target);
 expect(request).toHaveBeenCalledTimes(3);
});
it('retains an unsupported handoff and resumes it without replaying the account activation',async()=>{
 const journal=new MemoryActivationJournal(),request=vi.fn().mockResolvedValueOnce(redirect(worker)),log=vi.fn();
 await expect(new ActivationFlow(journal,request,log).run(target,link)).rejects.toThrow(/unsupported/);
 expect(await journal.read(target.uuid)).toMatchObject({stage:'worker-pending',url:worker});
 const after=vi.fn().mockResolvedValueOnce(redirect(completion)).mockResolvedValueOnce(success);
 await new ActivationFlow(journal,after,log,fixtureWorker).run(target);
 expect(after.mock.calls.map(c=>c[0])).toEqual([worker,completion]);
});
it('does not replay a worker request whose outcome is uncertain',async()=>{
 const journal=new MemoryActivationJournal(),request=vi.fn().mockResolvedValueOnce(redirect(worker)).mockRejectedValueOnce(new Error('timeout'));
 await expect(new ActivationFlow(journal,request,vi.fn(),fixtureWorker).run(target,link)).rejects.toThrow();
 expect(await journal.read(target.uuid)).toMatchObject({stage:'worker-submitting',url:null});
 await expect(new ActivationFlow(journal,request,vi.fn(),fixtureWorker).run(target)).rejects.toThrow(/uncertain/);
 expect(request).toHaveBeenCalledTimes(2);
});
it('can recheck the completion page without resubmitting either activation request',async()=>{
 const journal=new MemoryActivationJournal(),request=vi.fn().mockResolvedValueOnce(redirect(worker)).mockResolvedValueOnce(redirect(completion)).mockResolvedValueOnce({...success,status:503});
 await expect(new ActivationFlow(journal,request,vi.fn(),fixtureWorker).run(target,link)).rejects.toThrow(/not confirmed/);
 const after=vi.fn().mockResolvedValue(success);
 await new ActivationFlow(journal,after,vi.fn(),fixtureWorker).run(target);
 expect(after.mock.calls).toEqual([[completion]]);
});
it('recognizes a completion heading split across HTML nodes without whitespace',async()=>{
 const journal=new MemoryActivationJournal(),request=vi.fn().mockResolvedValueOnce(redirect(worker)).mockResolvedValueOnce(redirect(completion)).mockResolvedValueOnce({...success,body:'<h1>Your database has been<br><strong>activated</strong>!</h1>'});
 await new ActivationFlow(journal,request,vi.fn(),fixtureWorker).run(target,link);
 expect(await journal.read(target.uuid)).toMatchObject({stage:'complete',url:null});
});
it('rejects a challenge even when scripts contain the expected confirmation wording',async()=>{
 const request=vi.fn().mockResolvedValueOnce(redirect(worker)).mockResolvedValueOnce(redirect(completion)).mockResolvedValueOnce({...success,body:'<h1>Verify you are human</h1><script>"Your database has been activated";</script>'});
 await expect(new ActivationFlow(new MemoryActivationJournal(),request,vi.fn(),fixtureWorker).run(target,link)).rejects.toThrow(/not confirmed/);
});
it('permits inert completion HTML without relying on translated or client-rendered message text',async()=>{
 const journal=new MemoryActivationJournal(),request=vi.fn().mockResolvedValueOnce(redirect(worker)).mockResolvedValueOnce(redirect(completion)).mockResolvedValueOnce({...success,body:'<main id="completion"></main><script>renderCompletion()</script>'});
 await new ActivationFlow(journal,request,vi.fn(),fixtureWorker).run(target,link);
 expect(await journal.read(target.uuid)).toMatchObject({stage:'complete',url:null});
});
it('never follows an unrelated host or an unbound completion page',async()=>{
 for(const bad of [worker.replace('fixture.odoo.com','other.odoo.com'),worker.replace('https:','http:'),worker.replace('https://','https://user:secret@')]){
  const request=vi.fn().mockResolvedValue(redirect(bad));
  await expect(new ActivationFlow(new MemoryActivationJournal(),request,vi.fn(),fixtureWorker).run(target,link)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
 }
 for(const bad of [completion.replace(target.uuid,'22222222-2222-4222-8222-222222222222'),completion+'&login=other@example.com',completion.replace('/invite-users','/delete-database'),completion.replace('login=user','login=other'),completion+'&redirect=https://evil.example']){
  expect(()=>activationCompletionURL(bad,target)).toThrow();
 }
});
it('checks stored identity and saves intent before transmitting any request',async()=>{
 const journal=new MemoryActivationJournal(),request=vi.fn().mockResolvedValue(redirect(worker));
 await expect(new ActivationFlow(journal,request,vi.fn()).run(target,link)).rejects.toThrow();
 await expect(new ActivationFlow(journal,request,vi.fn()).run({...target,email:'other@example.com'})).rejects.toThrow(/identity/);
 expect(request).toHaveBeenCalledTimes(1);
 const broken={read:async()=>null,write:async()=>{throw new Error('full');}},never=vi.fn();
 await expect(new ActivationFlow(broken,never,vi.fn()).run(target,link)).rejects.toThrow();
 expect(never).not.toHaveBeenCalled();
});

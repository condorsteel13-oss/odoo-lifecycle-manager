import { makeProgress } from '../../src/shared/progress';
import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { demoDiscovery, DEFAULT_SETTINGS } from '../../src/domain/demo';

test('manual live UI separates creation, verification and deletion with all attestations',async()=>{
 const server=createServer(async(req,res)=>{try{const path=req.url==='/'?'dist/index.html':`dist${req.url}`;if(!/^dist\/(?:index.html|assets\/[a-zA-Z0-9._-]+)$/.test(path))throw 0;res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'} as any)[extname(path)]);res.end(await readFile(path));}catch{res.writeHead(404);res.end();}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const folder=(await readdir('browser-binaries')).find(n=>/^chromium-/.test(n))!;
 const browser=await chromium.launch({executablePath:resolve('browser-binaries',folder,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1380,height:1100}});
  // This UI fixture has no path to an Odoo account, native IPC, or real network.
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const discovery=demoDiscovery();discovery.source='odoo';discovery.databases=discovery.databases.slice(0,1).map(d=>({...d,id:'https://fixture.odoo.com',name:'fixture',url:'https://fixture.odoo.com',source:'odoo',deletion:'available',duplication:'available'}));
  discovery.databases.push({...discovery.databases[0],name:'example-accounting-0805',id:'https://example-accounting-0805.odoo.com',url:'https://example-accounting-0805.odoo.com'});
  const oldName=`fixture-copy-${new Date().toISOString().slice(0,10).replaceAll('-','')}`;
  const oldRecord={id:'old-cycle',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),original:discovery.databases[0],copyName:oldName,phase:'awaiting-expiry',copy:{...discovery.databases[0],name:oldName},copyUuid:'22222222-2222-4222-8222-222222222222',verifiedAt:null,message:'Fixture: previous copy removed manually.',backupReference:null,integrityNotes:null};
  const state={workflowPreferences:{activationEmailDelayMinutes:3,copyNameTemplate:'{name}-copy-{date}'},lifecyclePreferences:{safeMode:true},lifecycleRun:null,lifecycleQueue:[],browserPreferences:{headless:true},savedConnections:{odoo:true,mail:false},mailConnection:{status:'disconnected',email:null,checkedAt:null},odooCheckedAt:null,settings:{...DEFAULT_SETTINGS,deleteAfterActivation:true},discovery,history:[],liveHistory:[oldRecord],liveSafetyLock:false,connection:'connected',busy:false,diagnostics:[],lastAttemptAt:null,nextCheckAt:null,dataDirectory:'/fixture',browserDirectory:'/fixture'};
  await page.addInitScript(initial=>{
    (window as any).updates={state:async()=>({currentVersion:'1.8.0',latestVersion:null,automatic:false,supported:false,status:'idle',percent:0,checkedAt:null,message:'Offline UI fixture',installBlockReason:null}),subscribe:()=>()=>{}};
    const state:any=initial;let publish:(state:any)=>void=()=>{};let copyName='';let pending:any=null;
    (window as any).fixtureCalls=[];
    const notify=()=>publish(structuredClone(state));
    const makeReview=(action:string,record:any=null)=>({ticket:'11111111-1111-4111-8111-111111111111',expiresAt:new Date(Date.now()+300000).toISOString(),action,original:state.discovery.databases[0],copyName,copy:record?.copy??null,recordId:record?.id??null});
    (window as any).lifecycle={state:async()=>structuredClone(state),subscribe:(fn:any)=>{publish=fn;return()=>{};},cancelLive:async()=>{pending=null;},closeRemovedCopy:async(input:any)=>{const r=state.liveHistory.find((r:any)=>r.id===input.recordId);if(!input.removedByUser)throw Error('Removal must be reported');r.phase='copy-removed';r.message='Fixture: closed after user-reported removal; history retained.';notify();},prepareDuplicate:async(_id:string,name:string)=>{copyName=name;pending=makeReview('duplicate');return pending;},prepareDelete:async()=>{pending=makeReview('delete',state.liveHistory[0]);return pending;},confirmLive:async(input:any)=>{(window as any).fixtureCalls.push({action:pending.action,input});if(pending.action==='duplicate'){state.liveHistory=[{id:'fixture-action',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),original:state.discovery.databases[0],copyName,phase:'awaiting-copy',copy:null,copyUuid:null,verifiedAt:null,message:'Fixture: creation accepted; original retained.',backupReference:null,integrityNotes:null},...state.liveHistory];}else{state.liveHistory[0].phase='deleted';state.liveHistory[0].message='Fixture: deletion acknowledged.';}pending=null;notify();},activateCopy:async()=>{const r=state.liveHistory[0];r.phase='activation-pending';r.activation={userEmail:'current@example.com',recipientEmail:'old@example.com',send:'sent',sentAt:new Date().toISOString(),link:'not-started'};notify();},readActivationEmail:async()=>{const r=state.liveHistory[0];r.phase='awaiting-expiry';r.copy={...r.original,name:copyName,expiresAt:null,remainingDays:0,expirationObservedAt:new Date().toISOString()};r.activationVerifiedAt=new Date().toISOString();r.activationExpiresAt='2026-10-22T18:40:15Z';r.message='Fixture: activated; expiry still unverified.';notify();},verifyCopy:async()=>{const r=state.liveHistory[0];r.phase='copy-verified';r.copy={...r.original,name:copyName,expiresAt:null,remainingDays:31,expirationObservedAt:new Date().toISOString()};r.copyUuid='22222222-2222-4222-8222-222222222222';r.verifiedAt=new Date().toISOString();notify();}};
    const api=(window as any).lifecycle,manualConfirm=api.confirmLive;
    const readActivation=api.readActivationEmail;
    api.readActivationEmail=async()=>{await readActivation();state.liveHistory[0].activation.completion='complete';notify();};
    (window as any).fixturePendingActivation=()=>{const r=state.liveHistory[0];r.phase='activation-pending';r.activation.completion='pending';notify();};
    (window as any).fixtureProgress=(progress:any)=>{const record=state.liveHistory[0];record.progress=progress;record.progressEvents=[...(record.progressEvents??[]),progress];state.lifecycleRun={recordId:record.id,stage:progress.message,progress,active:progress.status==='running'||progress.status==='waiting',stopping:false};notify();};
    (window as any).fixtureTemplate=(template:string)=>{state.workflowPreferences.copyNameTemplate=template;notify();};
    (window as any).fixtureSafeMode=(safe:boolean)=>{state.lifecyclePreferences.safeMode=safe;notify();};
    api.retainCopy=async(id:string)=>{const record=state.liveHistory.find((r:any)=>r.id===id);record.phase='copy-retained';record.message='Fixture: both databases retained.';notify();};
    api.runLifecycle=async(id:string,name:string)=>{
      (window as any).fixtureCalls.push({action:'run-lifecycle',id,name});
      if(state.lifecyclePreferences.safeMode){const review=await api.prepareDuplicate(id,name);review.workflow='guided';return review;}
      state.liveHistory=[{...state.liveHistory[0],id:'automatic-cycle',copyName:name,phase:'deleted',workflow:'automatic',message:'Fixture: automatic cycle complete.'},...state.liveHistory];notify();return null;
    };
    api.confirmLive=async(input:any)=>{
      const guided=pending?.workflow==='guided'&&pending.action==='duplicate';await manualConfirm(input);
      if(guided){await api.verifyCopy();const review=await api.prepareDelete();review.workflow='guided';return review;}return null;
    };
  },state);
  await page.clock.install();
  await page.goto(origin);await page.getByRole('button',{name:'Live actions',exact:true}).click();
  await page.getByRole('button',{name:'I removed this copy — close cycle'}).click();await expect(page.getByText('Fixture: closed after user-reported removal; history retained.')).toBeVisible();expect(await page.evaluate(()=>(window as any).fixtureCalls)).toEqual([]);await expect(page.getByRole('button',{name:'Verify copy',exact:true})).toHaveCount(0);
  expect(await page.getByLabel('Original database').locator('option').allTextContents()).not.toContain('example-accounting-0805');
  await page.getByLabel('Original database').selectOption('https://fixture.odoo.com');await expect(page.getByLabel('Copy name',{exact:true})).toHaveValue(`${oldName}-2`);await page.getByLabel('Copy name',{exact:true}).fill('fixture-copy');await page.getByRole('button',{name:'Review duplication',exact:true}).click();
  const create=page.getByRole('button',{name:'Continue to create confirmation'});await expect(create).toBeDisabled();
  await page.getByLabel('Confirm original name').fill('fixture-copy');await page.getByRole('checkbox',{name:/I authorize/}).check();await expect(create).toBeDisabled();
  await page.getByLabel('Confirm original name').fill('fixture');await expect(create).toBeEnabled();expect(await page.evaluate(()=>(window as any).fixtureCalls)).toEqual([]);await create.click();
  await expect(page.getByRole('button',{name:'Review deletion of original'})).toHaveCount(0);
  await page.getByRole('button',{name:'Activate copy',exact:true}).click();await expect(page.getByText(/Signed-in Odoo user: current@example.com/)).toBeVisible();await expect(page.getByRole('button',{name:/Email check in/})).toBeDisabled();await page.clock.fastForward(180_000);await page.getByRole('button',{name:'Read activation email',exact:true}).click();await expect(page.getByText('Fixture: activated; expiry still unverified.')).toBeVisible();await expect(page.getByRole('button',{name:'Review deletion of original'})).toHaveCount(0);
  await page.evaluate(()=>(window as any).fixturePendingActivation());
  await expect(page.getByRole('button',{name:'Read activation email',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Review deletion of original'})).toHaveCount(0);
  await page.getByRole('button',{name:'Complete activation',exact:true}).click();
  await page.getByRole('button',{name:'Verify copy',exact:true}).click();await page.getByRole('button',{name:'Review deletion of original'}).click();
  const remove=page.getByRole('button',{name:'Continue to deletion confirmation'});await expect(remove).toBeDisabled();
  await page.getByLabel('Confirm original name').fill('fixture');await page.getByRole('checkbox',{name:/deletion is permanent/}).check();
  await page.getByRole('checkbox',{name:/recoverable backup/}).check();await page.getByLabel('Backup reference').fill('Offline restore-tested backup');
  await page.getByRole('checkbox',{name:/opened the copy/}).check();await page.getByLabel('Integrity checks').fill('Checked orders, attachments and totals.');await expect(remove).toBeDisabled();
  await page.getByRole('checkbox',{name:/subscription closure/}).check();await expect(remove).toBeEnabled();
  await page.screenshot({path:'test-results/live-deletion-review.png',fullPage:true});
  await remove.click();expect((await page.evaluate(()=>(window as any).fixtureCalls)).map((c:any)=>c.action)).toEqual(['duplicate','delete']);await expect(page.getByText('Fixture: deletion acknowledged.')).toBeVisible();
  await page.evaluate(()=>(window as any).fixtureTemplate('{name}-backup'));
  await page.getByLabel('Original database').selectOption('');await page.getByLabel('Original database').selectOption('https://fixture.odoo.com');
  await expect(page.getByLabel('Copy name',{exact:true})).toHaveValue('fixture-backup');
  await page.getByLabel('Copy name',{exact:true}).fill('fixture-guided-copy');await page.getByRole('button',{name:'Run lifecycle',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review real duplication'})).toBeVisible();await expect(page.getByText(/Deletion requires a second, separate confirmation/)).toBeVisible();
  await page.getByLabel('Confirm original name').fill('fixture');await page.getByRole('checkbox',{name:/I authorize/}).check();await page.getByRole('button',{name:'Continue to create confirmation'}).click();
  await expect(page.getByRole('heading',{name:'Review permanent deletion'})).toBeVisible();await expect(page.getByRole('button',{name:'Continue to deletion confirmation'})).toBeDisabled();
  await page.getByRole('button',{name:'Cancel review',exact:true}).click();
  await page.getByRole('button',{name:'Keep both databases — close cycle',exact:true}).click();await expect(page.getByText('Fixture: both databases retained.')).toBeVisible();await expect(page.getByRole('button',{name:'Review deletion of original'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Continue lifecycle',exact:true})).toHaveCount(0);
  await page.evaluate(()=>(window as any).fixtureSafeMode(false));
  await expect(page.getByRole('button',{name:'Review duplication',exact:true})).toHaveCount(0);await expect(page.getByText(/permanently deletes its parent without further prompts/)).toBeVisible();
  await page.getByLabel('Copy name',{exact:true}).fill('fixture-automatic-copy');await page.getByRole('button',{name:'Run lifecycle',exact:true}).click();
  await expect(page.getByText('Fixture: automatic cycle complete.',{exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Live action review'})).toHaveCount(0);
  expect((await page.evaluate(()=>(window as any).fixtureCalls)).filter((call:any)=>call.action==='run-lifecycle')).toHaveLength(2);
  const sequence=[['duplicating','running'],['duplicate-done','done'],['created','done'],['waiting-email','waiting'],['email-received','done'],['activating','running'],['activation-done','done'],['deleting','running'],['deleted','done']] as const;
  for(const [step,status] of sequence){
    const progress=makeProgress('fixture','fixture-automatic-copy',step,status);
    await page.evaluate(value=>(window as any).fixtureProgress(value),progress);
    await expect(page.getByRole('progressbar',{name:'Lifecycle progress'}).first()).toHaveAttribute('value',String(progress.percent));
    await expect(page.getByRole('status').filter({hasText:progress.message}).first()).toBeVisible();
    if(step==='activating')await page.screenshot({path:'test-results/lifecycle-progress.png',fullPage:true});
  }
  await expect(page.getByRole('button',{name:'Stop lifecycle',exact:true})).toHaveCount(0);
  await page.getByText('Step history',{exact:true}).click();await expect(page.getByText('fixture duplication done',{exact:true})).toBeVisible();
  const failure=makeProgress('fixture','fixture-automatic-copy','deleting','uncertain','The request may have completed. Verify the outcome before continuing.');
  await page.evaluate(value=>(window as any).fixtureProgress(value),failure);
  await expect(page.getByRole('status').filter({hasText:'outcome uncertain'}).first()).toBeVisible();
  await expect(page.getByRole('progressbar').first()).toHaveAttribute('value','90');
  await page.screenshot({path:'test-results/lifecycle-uncertain.png',fullPage:true});

 }finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

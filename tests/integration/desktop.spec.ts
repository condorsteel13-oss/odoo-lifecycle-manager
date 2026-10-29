import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let desktop: ElectronApplication;
let directory: string;
test.afterEach(async () => { await desktop?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
test('desktop covers all screens, simulations, automatic deduplication, export and restart', async () => {
  directory = await mkdtemp(join(tmpdir(), 'odoo-desktop-test-'));
  const launch = () => electron.launch({ args: [resolve('.')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', LIFECYCLE_TEST_DATA: directory } });
  desktop = await launch();
  const page = await desktop.firstWindow();
  await expect(page.getByRole('heading', { name: 'Connect Odoo and Viamail once' })).toBeVisible();
  await page.getByRole('button',{name:/Databases/}).first().click();
  await expect(page.getByRole('heading', { name: 'Database overview' })).toBeVisible();
  await expect(page.getByText('Discovery and simulation are read-only. Safe mode confirms each live action.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined');
  await page.getByRole('button',{name:'Live actions',exact:true}).click();
  await expect(page.getByText('No live actions have been submitted.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Review duplication'})).toBeDisabled();
  await expect(page.evaluate(()=>window.lifecycle.prepareDuplicate('https://fixture.odoo.com','fixture-copy'))).rejects.toThrow(/connected/);
  await page.getByRole('button',{name:/Databases/}).first().click();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await page.getByRole('textbox', { name: 'Search databases' }).fill('atlas');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('checkbox', { name: 'Select atlas-staging', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select northwind-sandbox', exact: true }).check();
  await page.getByRole('button', { name: 'Simulate selected (2)' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('NO CHANGES MADE', { exact: true })).toBeVisible();
  await expect(page.getByText('Duplicate integrity verification', { exact: true })).toBeVisible();
  const exportPath = join(directory, 'test-export.json');
  await desktop.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, exportPath);
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  await expect.poll(async () => { try { return (await readFile(exportPath, 'utf8')).includes('NO CHANGES MADE'); } catch { return false; } }).toBe(true);
  expect(await readFile(exportPath, 'utf8')).not.toMatch(/"cookies"|"password"|"session"/);
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Automation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No automatic actions' })).toBeVisible();
  await page.getByRole('button', { name: 'Check now (read-only)' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.lifecycle.state())).history.length).toBe(5);
  await page.getByRole('button', { name: 'Check now (read-only)' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.lifecycle.state())).busy).toBe(false);
  expect((await page.evaluate(() => window.lifecycle.state())).history.length).toBe(5);
  await page.getByRole('spinbutton', { name: 'Expiration threshold' }).fill('5');
  await page.getByRole('button', { name: 'Save automation' }).click();
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect Odoo and Viamail once' })).toBeVisible();
  await expect(page.getByRole('region',{name:'Viamail connection'})).toBeVisible();
  await expect(page.getByLabel('Browser visibility')).toHaveValue('headless');
  await page.getByLabel('Browser visibility').selectOption('visible');
  await expect.poll(async()=>(await page.evaluate(()=>window.lifecycle.state())).browserPreferences.headless).toBe(false);
  // Never click Connect: integration tests have zero access to an actual Odoo account.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Browser session' })).toBeVisible();
  await page.getByRole('button', { name: 'Databases', exact: false }).first().click();
  await page.screenshot({ path: 'test-results/dashboard.png' });
  await desktop.close(); desktop = await launch();
  const reopened = await desktop.firstWindow();
  await expect(reopened.getByRole('heading', { name: 'Database overview' })).toBeVisible();
  const restored = await reopened.evaluate(() => window.lifecycle.state());
  expect(restored.browserPreferences.headless).toBe(false);expect(restored.mailConnection.status).toBe('disconnected');expect(restored.history).toHaveLength(5); expect(restored.settings.thresholdDays).toBe(5);
  await reopened.getByRole('button', { name: /Simulation history/ }).click();
  await expect(reopened.locator('.history-row')).toHaveCount(5);
});

test('Manage countdowns remain distinct from exact dates and survive restart',async()=>{
 const {LocalStore}=await import('../../electron/store');
 const {demoDiscovery}=await import('../../src/domain/demo');
 directory=await mkdtemp(join(tmpdir(),'odoo-countdown-test-'));
 const store=new LocalStore(join(directory,'data'));const {data}=await store.load();
 const discovery=demoDiscovery(new Date('2026-10-19T17:00:00Z'));
 discovery.databases[0]={...discovery.databases[0],expiresAt:null,remainingDays:31,expirationObservedAt:'2026-10-19T17:00:00Z',expirationEvidence:'Odoo Manage page: Your trial will expire in 31 day(s)'};
 await store.save({...data,discovery});
 const launch=()=>electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 desktop=await launch();let page=await desktop.firstWindow();
 await expect(page.getByText('Days reported',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Details for atlas-staging',exact:true}).click();
 await expect(page.getByRole('dialog').getByText('Days remaining (reported)',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog').getByText('31',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog').getByText(/Odoo Manage page: Your trial will expire in 31 day/)).toBeVisible();
 await desktop.close();desktop=await launch();page=await desktop.firstWindow();
 const saved=await page.evaluate(()=>window.lifecycle.state());
 expect(saved.discovery!.databases[0]).toMatchObject({expiresAt:null,remainingDays:31});
 expect(saved.settings.monitoringEnabled).toBe(false);
});

test('Safe mode opt-out and scheduled scope persist without starting any live work',async()=>{
 const {LocalStore}=await import('../../electron/store');const {demoDiscovery}=await import('../../src/domain/demo');
 directory=await mkdtemp(join(tmpdir(),'odoo-safe-mode-ui-'));const store=new LocalStore(join(directory,'data'));const {data}=await store.load(),discovery=demoDiscovery();
 discovery.databases.push({...discovery.databases[0],id:'https://example-accounting-0805.odoo.com',name:'example-accounting-0805'});await store.save({...data,discovery});
 const launch=()=>electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});desktop=await launch();let page=await desktop.firstWindow();
 await page.getByRole('button',{name:'Settings',exact:true}).click();const safe=page.getByRole('switch',{name:'Safe mode',exact:true});await expect(safe).toBeChecked();
 await desktop.evaluate(({dialog})=>{dialog.showMessageBox=async(...args:any[])=>{const options=args.at(-1);if(options.title!=='Turn Safe mode off?'||options.defaultId!==0)throw Error('Unexpected dialog');return {response:0,checkboxChecked:false};};});
 await safe.click();await expect(safe).toBeChecked();
 await desktop.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});await safe.click();await expect(safe).not.toBeChecked();
 expect((await page.evaluate(()=>window.lifecycle.state())).liveHistory).toEqual([]);
 await page.getByRole('button',{name:'Automation',exact:true}).click();const rule=page.getByLabel('Automation mode');await expect(rule).toHaveValue('off');
 await rule.selectOption('lifecycle');await page.getByLabel('Database scope').selectOption('selected');await expect(page.getByRole('checkbox',{name:'example-accounting-0805',exact:true})).toHaveCount(1);
 await expect(page.getByRole('button',{name:'Save automation',exact:true})).toBeDisabled();await expect(page.getByRole('alert')).toContainText('Select at least one database.');
 await page.getByRole('checkbox',{name:'atlas-staging',exact:true}).check();await page.getByLabel('Expiration threshold').fill('2');await page.getByRole('button',{name:'Save automation',exact:true}).click();
 await expect(page.getByRole('button',{name:'Run lifecycle now',exact:true})).toBeEnabled();
 const configured=await page.evaluate(()=>window.lifecycle.state());expect(configured.settings).toMatchObject({lifecycleEnabled:true,monitoringEnabled:false,scope:'selected',thresholdDays:2,databaseIds:[discovery.databases[0].id]});expect(configured.nextCheckAt).not.toBeNull();expect(configured.liveHistory).toEqual([]);
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/lifecycle-rule.png',fullPage:true});await desktop.close();desktop=await launch();page=await desktop.firstWindow();
 const restored=await page.evaluate(()=>window.lifecycle.state());expect(restored.lifecyclePreferences.safeMode).toBe(false);expect(restored.settings).toEqual(configured.settings);expect(restored.lifecycleRun).toBeNull();expect(restored.liveHistory).toEqual([]);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('switch',{name:'Safe mode',exact:true}).click();await expect(page.getByRole('switch',{name:'Safe mode',exact:true})).toBeChecked();
});

test('duplication preferences validate, preview, reach simulations, and survive restart',async()=>{
 directory=await mkdtemp(join(tmpdir(),'odoo-workflow-settings-'));
 const launch=()=>electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 desktop=await launch();let page=await desktop.firstWindow();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const delay=page.getByLabel('Activation email delay (minutes)'),template=page.getByLabel('Copy name template'),save=page.getByRole('button',{name:'Save duplication settings',exact:true});
 await expect(delay).toHaveValue('3');await expect(template).toHaveValue('{name}-copy-{date}');await expect(save).toBeDisabled();
 await delay.fill('61');await expect(save).toBeDisabled();await expect(page.getByRole('alert')).toContainText('0 to 60');
 await delay.fill('5');await template.fill('copy');await expect(save).toBeDisabled();await expect(page.getByRole('alert')).toContainText('Include {name}');
 await template.fill('{name}-backup');await expect(page.locator('.name-preview')).toContainText('example-db-backup');await save.click();
 await expect(page.getByText('Duplication and activation settings saved.',{exact:true})).toBeVisible();
 const configured=await page.evaluate(()=>window.lifecycle.state());
 expect(configured.workflowPreferences).toEqual({activationEmailDelayMinutes:5,copyNameTemplate:'{name}-backup'});expect(configured.settings.lifecycleEnabled).toBe(false);expect(configured.settings.monitoringEnabled).toBe(false);expect(configured.liveHistory).toEqual([]);
 await expect(page.evaluate(()=>window.lifecycle.saveWorkflowPreferences({activationEmailDelayMinutes:2.5,copyNameTemplate:'{name}-copy'}))).rejects.toThrow(/0 to 60/);
 await page.evaluate(async()=>{const state=await window.lifecycle.state();await window.lifecycle.simulate([state.discovery!.databases[0].id]);});
 const simulated=await page.evaluate(()=>window.lifecycle.state());expect(simulated.history[0].proposedName).toBe('atlas-staging-backup');
 await page.screenshot({path:'test-results/workflow-settings.png',fullPage:true});
 await desktop.close();desktop=await launch();page=await desktop.firstWindow();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByLabel('Activation email delay (minutes)')).toHaveValue('5');await expect(page.getByLabel('Copy name template')).toHaveValue('{name}-backup');
 expect((await page.evaluate(()=>window.lifecycle.state())).liveHistory).toEqual([]);
});

for (const flags of [
 {monitoringEnabled:false,lifecycleEnabled:false,title:'Automation is off',mode:'off'},
 {monitoringEnabled:true,lifecycleEnabled:false,title:'Monitor only is on',mode:'monitor'},
 {monitoringEnabled:false,lifecycleEnabled:true,title:'Automatic lifecycle is on',mode:'lifecycle'},
 {monitoringEnabled:true,lifecycleEnabled:true,title:'Automatic lifecycle is on',mode:'lifecycle'},
]) test(`one automation mode represents saved flags ${flags.monitoringEnabled}/${flags.lifecycleEnabled} and Off disables both`,async()=>{
 const {LocalStore}=await import('../../electron/store');const {demoDiscovery}=await import('../../src/domain/demo');
 directory=await mkdtemp(join(tmpdir(),'odoo-simple-automation-'));const store=new LocalStore(join(directory,'data'));const {data}=await store.load();
 await store.save({...data,discovery:demoDiscovery(),settings:{...data.settings,monitoringEnabled:flags.monitoringEnabled,lifecycleEnabled:flags.lifecycleEnabled,deleteAfterActivation:true},lastAttemptAt:new Date().toISOString()});
 desktop=await electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 const page=await desktop.firstWindow();await page.getByRole('button',{name:'Automation',exact:true}).click();
 const status=page.getByRole('region',{name:'Saved automation status'}),mode=page.getByLabel('Automation mode'),save=page.getByRole('button',{name:'Save automation',exact:true});
 await expect(status.getByRole('heading',{name:flags.title,exact:true})).toBeVisible();await expect(mode).toHaveValue(flags.mode);await expect(save).toBeDisabled();
 const initial=await page.evaluate(()=>window.lifecycle.state());
 await mode.selectOption(flags.mode==='monitor'?'lifecycle':'monitor');
 await expect(status.getByRole('heading',{name:flags.title,exact:true})).toBeVisible();
 await expect(page.getByText('Unsaved changes. The saved automation above is still in effect.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:flags.lifecycleEnabled?'Run lifecycle now':'Check now (read-only)',exact:true})).toBeDisabled();
 expect((await page.evaluate(()=>window.lifecycle.state())).settings).toEqual(initial.settings);
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`test-results/automation-edit-${flags.mode}-${flags.monitoringEnabled}.png`,fullPage:true});
 if(flags.mode==='monitor'){
  await mode.selectOption('monitor');await expect(save).toBeDisabled();
  await mode.selectOption('lifecycle');await save.click();
  await expect(status.getByRole('heading',{name:'Automatic lifecycle is on',exact:true})).toBeVisible();
  expect((await page.evaluate(()=>window.lifecycle.state())).settings).toMatchObject({monitoringEnabled:false,lifecycleEnabled:true});
 }
 await mode.selectOption('monitor');await save.click();await expect(status.getByRole('heading',{name:'Monitor only is on',exact:true})).toBeVisible();
 expect((await page.evaluate(()=>window.lifecycle.state())).settings).toMatchObject({monitoringEnabled:true,lifecycleEnabled:false,deleteAfterActivation:true});
 await mode.selectOption('off');await save.click();await expect(status.getByRole('heading',{name:'Automation is off',exact:true})).toBeVisible();
 const stopped=await page.evaluate(()=>window.lifecycle.state());expect(stopped.settings).toMatchObject({monitoringEnabled:false,lifecycleEnabled:false,deleteAfterActivation:true});expect(stopped.nextCheckAt).toBeNull();expect(stopped.liveHistory).toEqual([]);expect(stopped.lifecycleQueue).toEqual([]);
 await desktop.close();desktop=await electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 const reopened=await desktop.firstWindow();await reopened.getByRole('button',{name:'Automation',exact:true}).click();await expect(reopened.getByLabel('Automation mode')).toHaveValue('off');
});

test('parent deletion defaults off and the Automation choice persists independently of Safe mode',async()=>{
 directory=await mkdtemp(join(tmpdir(),'odoo-deletion-setting-'));
 const launch=()=>electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 desktop=await launch();let page=await desktop.firstWindow();
 await page.getByRole('button',{name:'Automation',exact:true}).click();
 const deletion=page.getByRole('checkbox',{name:'Delete original after successful activation',exact:true});
 await expect(deletion).not.toBeChecked();await expect(page.getByText(/Keep both databases. Use this to test without deletion/)).toBeVisible();
 await deletion.check();await page.getByRole('button',{name:'Save automation',exact:true}).click();
 await expect.poll(async()=>(await page.evaluate(()=>window.lifecycle.state())).settings.deleteAfterActivation).toBe(true);
 await deletion.uncheck();await page.getByRole('button',{name:'Save automation',exact:true}).click();
 await expect.poll(async()=>(await page.evaluate(()=>window.lifecycle.state())).settings.deleteAfterActivation).toBe(false);
 await page.screenshot({path:'test-results/automation-retain-original.png',fullPage:true});
 await desktop.close();desktop=await launch();page=await desktop.firstWindow();
 await page.getByRole('button',{name:'Automation',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Delete original after successful activation',exact:true})).not.toBeChecked();
 const state=await page.evaluate(()=>window.lifecycle.state());expect(state.settings.lifecycleEnabled).toBe(false);expect(state.lifecyclePreferences.safeMode).toBe(true);expect(state.liveHistory).toEqual([]);
});

test('Settings and Live actions share the deletion choice without enabling rules or starting actions',async()=>{
 directory=await mkdtemp(join(tmpdir(),'odoo-live-action-settings-'));
 const launch=()=>electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 desktop=await launch();let page=await desktop.firstWindow();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const deletion=page.getByRole('checkbox',{name:'Delete original database after successful activation',exact:true});
 await expect(deletion).not.toBeChecked();await deletion.check();await expect(deletion).toBeChecked();
 await page.getByRole('button',{name:'Live actions',exact:true}).click();await expect(deletion).toBeChecked();
 const configured=await page.evaluate(()=>window.lifecycle.state());
 expect(configured.settings).toMatchObject({deleteAfterActivation:true,monitoringEnabled:false,lifecycleEnabled:false});expect(configured.lifecyclePreferences.safeMode).toBe(true);expect(configured.liveHistory).toEqual([]);
 await desktop.close();desktop=await launch();page=await desktop.firstWindow();
 await page.getByRole('button',{name:'Live actions',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'Delete original database after successful activation',exact:true})).toBeChecked();
 await page.getByRole('checkbox',{name:'Delete original database after successful activation',exact:true}).uncheck();
 await page.getByRole('button',{name:'Automation',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Delete original after successful activation',exact:true})).not.toBeChecked();
 const retained=await page.evaluate(()=>window.lifecycle.state());expect(retained.settings.deleteAfterActivation).toBe(false);expect(retained.liveHistory).toEqual([]);
});

test('update preferences persist and development builds cannot download or install',async()=>{
 directory=await mkdtemp(join(tmpdir(),'odoo-update-desktop-'));
 const launch=()=>electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 desktop=await launch();let page=await desktop.firstWindow();await page.getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByRole('heading',{name:'App updates',exact:true})).toBeVisible();
 const automatic=page.getByRole('checkbox',{name:'Automatically check and download updates',exact:true});await expect(automatic).toBeChecked();
 await expect(page.getByRole('button',{name:'Check for updates',exact:true})).toBeDisabled();
 await expect(page.evaluate(()=>window.updates.install())).rejects.toThrow(/packaged/);
 await automatic.uncheck();await expect.poll(async()=>(await page.evaluate(()=>window.updates.state())).automatic).toBe(false);
 expect((await page.evaluate(()=>window.lifecycle.state())).liveHistory).toEqual([]);
 await page.screenshot({path:'test-results/update-settings.png',fullPage:true});
 await desktop.close();desktop=await launch();page=await desktop.firstWindow();await page.getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'Automatically check and download updates',exact:true})).not.toBeChecked();
 expect((await page.evaluate(()=>window.lifecycle.state())).liveHistory).toEqual([]);
});

test('update UI shows download progress and blocks restart until lifecycle work is idle',async()=>{
 directory=await mkdtemp(join(tmpdir(),'odoo-update-ui-'));
 desktop=await electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 const page=await desktop.firstWindow();await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('heading',{name:'App updates',exact:true})).toBeVisible();
 const baseline=await page.evaluate(()=>window.updates.state());
 const publish=async(patch:Partial<typeof baseline>)=>desktop.evaluate(({BrowserWindow},state)=>{BrowserWindow.getAllWindows()[0].webContents.send('updates:changed',state);},{...baseline,supported:true,latestVersion:'1.9.0',...patch});
 await publish({status:'downloading',percent:42,message:'Downloading version 1.9.0…'});
 await expect(page.getByRole('progressbar',{name:'Update download'})).toHaveAttribute('value','42');
 await publish({status:'ready',percent:100,message:'Version 1.9.0 is ready.',installBlockReason:'Wait for the current operation or lifecycle to finish before restarting.'});
 await expect(page.getByRole('button',{name:'Restart to install 1.9.0',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Update ready · View in Settings',exact:true})).toBeVisible();
 await page.screenshot({path:'test-results/update-ready-waiting.png',fullPage:true});
 await publish({status:'ready',percent:100,message:'Version 1.9.0 is ready.',installBlockReason:null});
 await expect(page.getByRole('button',{name:'Restart to install 1.9.0',exact:true})).toBeEnabled();
 // Renderer display is a fixture; the real main process still rejects installation in development.
 await page.getByRole('button',{name:'Restart to install 1.9.0',exact:true}).click();await expect(page.getByRole('alert')).toContainText('packaged');
 expect((await page.evaluate(()=>window.lifecycle.state())).liveHistory).toEqual([]);
});

test('live log visibility persists and native date-filtered debug export preserves the log',async()=>{
 const {LocalStore}=await import('../../electron/store');const {demoDiscovery}=await import('../../src/domain/demo');
 directory=await mkdtemp(join(tmpdir(),'odoo-live-log-tools-'));const store=new LocalStore(join(directory,'data'));const {data}=await store.load();
 const current=new Date(Date.now()-300000).toISOString(),old=new Date(Date.now()-400*86400000).toISOString(),original=demoDiscovery().databases[0];
 const make=(at:string,name:string)=>({id:crypto.randomUUID(),createdAt:at,updatedAt:at,original,originalUuid:'22222222-2222-4222-8222-222222222222',copyName:name,phase:'copy-retained' as const,copy:null,copyUuid:null,verifiedAt:null,message:'Fixture outcome. token=PRIVATE_TOKEN https://fixture.odoo.com/confirm?token=PRIVATE_LINK',backupReference:'PRIVATE_BACKUP',integrityNotes:'PRIVATE_NOTES',progressEvents:[{step:'retained' as const,status:'done' as const,percent:100,at,message:'Fixture completed'}]});
 await store.save({...data,discovery:demoDiscovery(),liveHistory:[make(current,'recent-copy'),make(old,'old-copy')]});
 const launch=()=>electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 desktop=await launch();let page=await desktop.firstWindow();await page.getByRole('button',{name:'Live actions',exact:true}).click();
 await expect(page.getByRole('heading',{name:/atlas-staging → recent-copy/})).toBeVisible();
 await page.getByRole('button',{name:'Hide log',exact:true}).click();await expect(page.locator('#live-log-body')).toHaveCount(0);
 await page.getByText('Export debug log',{exact:true}).click();await page.getByLabel('Log export date range').selectOption('hour');await expect(page.getByText(/1 matching run\./)).toBeVisible();
 const exportPath=join(directory,'live-debug.json');
 await desktop.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exportPath);
 await page.getByRole('button',{name:'Export JSON',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Debug log saved to'})).toBeVisible();
 let exported=JSON.parse(await readFile(exportPath,'utf8'));expect(exported.records.map((r:any)=>r.copyName)).toEqual(['recent-copy']);expect(exported.records[0].progressEvents).toHaveLength(1);expect(JSON.stringify(exported)).not.toMatch(/PRIVATE_/);
 const today=new Date().toLocaleDateString('en-CA');await page.getByLabel('Log export date range').selectOption('custom');
 await expect(page.getByRole('button',{name:'Export JSON',exact:true})).toBeDisabled();
 await page.getByLabel('Log export from date').fill(today);await page.getByLabel('Log export through date').fill(today);await page.getByRole('button',{name:'Export JSON',exact:true}).click();
 await expect.poll(async()=>JSON.parse(await readFile(exportPath,'utf8')).range.from).toBe(new Date(new Date().setHours(0,0,0,0)).toISOString());
 await page.getByLabel('Log export date range').selectOption('all');await page.getByRole('button',{name:'Export JSON',exact:true}).click();
 await expect.poll(async()=>JSON.parse(await readFile(exportPath,'utf8')).records.length).toBe(2);
 const before=await page.evaluate(()=>window.lifecycle.state());
 await expect(page.evaluate(()=>window.lifecycle.exportLiveLog({from:'invalid',to:'invalid'}))).rejects.toThrow(/valid start and end/);
 await desktop.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true,filePath:''});});
 expect(await page.evaluate(()=>window.lifecycle.exportLiveLog({from:'1970-01-01T00:00:00.000Z',to:new Date().toISOString()}))).toBeNull();
 expect((await page.evaluate(()=>window.lifecycle.state())).liveHistory).toEqual(before.liveHistory);
 await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await page.screenshot({path:'test-results/live-log-hidden-export.png',fullPage:true});
 await desktop.close();desktop=await launch();page=await desktop.firstWindow();await page.getByRole('button',{name:'Live actions',exact:true}).click();
 await expect(page.getByRole('button',{name:'Show log',exact:true})).toBeVisible();await page.getByRole('button',{name:'Show log',exact:true}).click();await expect(page.getByRole('heading',{name:/atlas-staging → recent-copy/})).toBeVisible();expect((await page.evaluate(()=>window.lifecycle.state())).liveHistory).toHaveLength(2);
});

test('sidebar workspace switch is available above the logo, pauses rules, and persists selection',async()=>{
 const {LocalStore}=await import('../../electron/store');const {demoDiscovery}=await import('../../src/domain/demo');
 directory=await mkdtemp(join(tmpdir(),'odoo-workspace-setting-'));const store=new LocalStore(join(directory,'data'));const {data}=await store.load();
 const discovery={...demoDiscovery(),source:'odoo' as const};
 await store.save({...data,discovery,settings:{...data.settings,monitoringEnabled:true,lifecycleEnabled:true},lastAttemptAt:new Date().toISOString()});
 const launch=()=>electron.launch({args:[resolve('.')],env:{...process.env,ELECTRON_RUN_AS_NODE:'',LIFECYCLE_TEST_DATA:directory}});
 desktop=await launch();let page=await desktop.firstWindow();await page.getByRole('button',{name:'Settings',exact:true}).click();
 const control=page.getByRole('switch',{name:'Use my Odoo workspace',exact:true});await expect(control).toBeChecked();
 const switchBox=await control.boundingBox(),brandBox=await page.locator('.sidebar .brand').boundingBox();
 expect(switchBox!.y+switchBox!.height).toBeLessThan(brandBox!.y);
 await expect(page.getByRole('switch',{name:'Use my Odoo workspace',exact:true})).toHaveCount(1);
 await page.screenshot({path:'test-results/sidebar-workspace-switch.png'});
 const before=await page.evaluate(()=>window.lifecycle.state());
 await desktop.evaluate(({BrowserWindow},value)=>BrowserWindow.getAllWindows()[0].webContents.send('app:state-changed',{...value,busy:true}),before);
 await expect(control).toBeDisabled();
 await desktop.evaluate(({BrowserWindow},value)=>BrowserWindow.getAllWindows()[0].webContents.send('app:state-changed',value),before);
 await expect(control).toBeEnabled();await control.click();await expect(control).not.toBeChecked();
 expect((await page.evaluate(()=>window.lifecycle.state())).settings).toMatchObject({lifecycleEnabled:false,monitoringEnabled:false});
 for(const screen of ['Databases','Connection','Automation','Simulation history','Live actions','Settings']){
  await page.getByRole('button',{name:screen==='Databases'?/^Databases/:screen,exact:screen!=='Databases'}).click();
  await expect(control).toBeVisible();await expect(control).not.toBeChecked();
 }
 await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,740));
 await expect.poll(async()=>{const box=await page.locator('.sidebar .version').boundingBox();return box!.y+box!.height<=(await page.evaluate(()=>window.innerHeight));}).toBe(true);
 await page.screenshot({path:'test-results/sidebar-workspace-switch-small.png'});
 // Fail only the saved-login IPC in this isolated UI test; never contact an actual Odoo account.
 await desktop.evaluate(({ipcMain})=>{ipcMain.removeHandler('app:odoo-workspace');ipcMain.handle('app:odoo-workspace',()=>{throw Error('Go to Connection → Connect to Odoo to sign in again. Automation remains off.');});});
 await control.click();await expect(page.getByRole('alert')).toContainText('Connect to Odoo');await expect(control).not.toBeChecked();
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/workspace-settings.png',fullPage:true});
 await desktop.close();desktop=await launch();page=await desktop.firstWindow();await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('switch',{name:'Use my Odoo workspace',exact:true})).not.toBeChecked();expect((await page.evaluate(()=>window.lifecycle.state())).liveHistory).toEqual([]);
});

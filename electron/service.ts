import { makeProgress, withProgress } from '../src/shared/progress';
import type { WorkflowPreferences } from '../src/shared/workflow';
import { copyNameTemplateError } from '../src/domain/copy-name';
import { rm } from 'node:fs/promises';
import type { AppState, Discovery, Settings, Simulation, ScheduledCycle } from '../src/shared/types';
import { demoDiscovery } from '../src/domain/demo';
import { scheduledCandidates, matchesLifecycleRule } from '../src/domain/lifecycle-schedule';
import { proposeName } from '../src/domain/simulation';
import { simulate } from '../src/domain/simulation';
import { dueDatabases, nextCheck } from '../src/domain/monitor';
import { LocalStore } from './store';
import { ReadOnlyBrowser } from './browser';
import { AppError, safeError } from './errors';
import { settingsSchema, workflowPreferencesSchema, browserPreferencesSchema, lifecyclePreferencesSchema, idsSchema, type Persisted } from './schemas';
import { LiveService, type NativeConfirmation, type LiveConnection } from './live-service';
import type { LiveConfirmation } from '../src/shared/live';
import { isProtected } from '../src/shared/live';
import { MailboxBrowser } from './mailbox';
import { SessionVault, type SessionCipher } from './session-vault';
import { LifecycleRunner, assertRunning } from './lifecycle-runner';
export interface ReadOnlyConnection { connect(): Promise<Discovery>; refresh(): Promise<Discovery>; close(): Promise<void>; finishLogin?(): void; check?():Promise<void>; applyMode?():Promise<void>; setHeadless?(value:boolean):Promise<void>; readonly isRunning?:boolean }
export interface MailConnection {connect():Promise<string>;finishLogin():void;check():Promise<string>;close():Promise<void>;setHeadless(value:boolean):Promise<void>;findActivationLink(target:import('./mailbox').MailTarget):Promise<string>;readonly isRunning?:boolean}
export class AppService {
  private state!: AppState;
  private browser: ReadOnlyConnection;
  private timer?: NodeJS.Timeout;
  private cancelled = false;
  private live: LiveService;
  private mailbox: MailConnection;
  private workflowController:AbortController|null=null;
  private updateLocked = false;
  private confirmAutomatic:()=>Promise<boolean>;
  private runnerWait?: (signal:AbortSignal)=>Promise<void>;
  constructor(private store: LocalStore, profile: string, browserRoot: string, private publish: (state: AppState) => void, browser?: ReadOnlyConnection, confirm: NativeConfirmation = async () => false, options:{cipher?:SessionCipher;mailbox?:MailConnection;confirmAutomatic?:()=>Promise<boolean>;runnerWait?:(signal:AbortSignal)=>Promise<void>}={}) {
    this.confirmAutomatic=options.confirmAutomatic??(async()=>false);this.runnerWait=options.runnerWait;
    this.browser = browser ?? new ReadOnlyBrowser(profile, browserRoot, error => this.log(error), options.cipher?new SessionVault(profile,'odoo',options.cipher):undefined);
    this.profile = profile;
    this.mailbox = options.mailbox??new MailboxBrowser(profile+'-webmail',options.cipher?new SessionVault(profile+'-webmail','mail',options.cipher):undefined);
    this.live = new LiveService(this.browser as ReadOnlyConnection & LiveConnection, () => this.state.liveHistory, liveHistory => this.saveLiveRecords(liveHistory), () => this.state.connection === 'connected' && this.state.discovery?.source === 'odoo' && !this.state.liveSafetyLock, confirm, {deletionAllowed:()=>this.state.settings.deleteAfterActivation,activationEmailDelayMinutes:()=>this.state.workflowPreferences.activationEmailDelayMinutes,automaticAllowed:()=>!this.state.lifecyclePreferences.safeMode&&!!this.workflowController&&!this.workflowController.signal.aborted,beforeMutation:()=>{if(this.workflowController)assertRunning(this.workflowController.signal);}});
  }
  private profile: string;
  async initialize() {
    const { data, recovered } = await this.store.load();
    this.state = { ...data, lifecycleRun:null, setupRequired:!data.discovery&&!data.savedConnections.odoo&&!data.savedConnections.mail, mailConnection:{status:'disconnected',email:null,checkedAt:null},odooCheckedAt:null, discovery: data.discovery ?? demoDiscovery(), connection: data.discovery?.source === 'odoo' ? 'disconnected' : 'demo', busy: false, diagnostics: [], nextCheckAt: null, dataDirectory: this.store.directory, browserDirectory: this.profile };
    const interrupted=this.state.liveHistory.map(record=>record.progress&&['running','waiting'].includes(record.progress.status)&&!['deleted','copy-retained','copy-removed'].includes(record.phase)
      ?withProgress(record,record.progress.step,['duplicate-submitting','delete-submitting','duplicate-unknown','delete-unknown'].includes(record.phase)?'uncertain':'stopped','App restarted before this step finished. Continue explicitly; no request was replayed.'):record);
    if(interrupted.some((record,index)=>record!==this.state.liveHistory[index]))await this.persist({liveHistory:interrupted});
    if (recovered) this.log(new AppError('STORAGE_RECOVERED', 'Invalid local state was preserved as state.corrupt-*.json. Defaults loaded; monitoring is disabled and live actions are locked.'));
    if(this.state.lifecycleQueue.some(job=>job.status==='running'))await this.persist({lifecycleQueue:this.state.lifecycleQueue.map(job=>job.status==='running'?{...job,status:'attention',message:'App restarted during this cycle. Inspect its record and continue explicitly; no action was replayed.'}:job)});
    await this.browser.setHeadless?.(this.state.browserPreferences.headless);
    await this.mailbox.setHeadless(this.state.browserPreferences.headless);
    this.emit();
    this.timer = setInterval(() => { const next = nextCheck(this.state.lastAttemptAt, this.state.settings); if (next && next.getTime() <= Date.now() && !this.state.busy) void this.runMonitor().catch(() => {});
      else if(!this.state.busy){
        if(this.state.connection==='connected'&&this.browser.isRunning===false)this.state.connection='disconnected';
        if(this.state.mailConnection.status==='connected'&&this.mailbox.isRunning===false)this.state.mailConnection.status='disconnected';
        this.emit();
        const times=[this.state.savedConnections.odoo&&!['expired','blocked'].includes(this.state.connection)?this.state.odooCheckedAt:null,this.state.savedConnections.mail&&this.state.mailConnection.status!=='expired'?this.state.mailConnection.checkedAt:null].filter(Boolean) as string[];
        if(times.some(t=>Date.now()-Date.parse(t)>5*60*1000))void this.exclusive(()=>this.checkSaved(this.state.savedConnections.odoo&&!['expired','blocked'].includes(this.state.connection),this.state.savedConnections.mail&&this.state.mailConnection.status!=='expired')).catch(()=>{});
      }
    }, 60000);
  }
  getState(): AppState { return structuredClone(this.state); }
  updateBlockReason(): string | null {
    if (this.updateLocked) return 'An update is being installed.';
    if (this.state.busy || this.workflowController || this.state.lifecycleRun?.active) return 'Wait for the current operation or lifecycle to finish before restarting.';
    const review = this.live.pendingReview();
    if (review && Date.parse(review.expiresAt) >= Date.now()) return 'Finish or cancel the open database confirmation before restarting.';
    return null;
  }
  acquireUpdateLock() {
    const reason = this.updateBlockReason();
    if (reason) throw new AppError('UPDATE_BUSY', reason);
    // Synchronous acquisition prevents the scheduler or an IPC action winning an await race.
    this.updateLocked = true; this.state.busy = true; this.emit();
  }
  releaseUpdateLock() { this.updateLocked = false; this.state.busy = false; this.emit(); }
  assertNotUpdating() { if (this.updateLocked) throw new AppError('UPDATE_BUSY', 'Wait for update installation to finish.'); }
  async closeForUpdate() {
    if (!this.updateLocked || this.workflowController || this.state.lifecycleRun?.active) throw new AppError('UPDATE_BUSY', 'A lifecycle must finish before updating.');
    // No abort or live.cancel here: only an already-idle app may reach this path.
    await this.browser.close(); await this.mailbox.close();
  }
  private emit() {
    this.state.nextCheckAt = nextCheck(this.state.lastAttemptAt, this.state.settings)?.toISOString() ?? null;
    this.publish(this.getState());
  }
  private log(error: unknown) {
    if (!this.state) return;
    const safe = safeError(error);
    this.state.diagnostics = [{ id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...safe }, ...this.state.diagnostics].slice(0, 100);
    if (safe.code === 'SAFETY_STOP') this.state.connection = 'blocked';
    if(['HEADLESS_BLOCKED','BACKGROUND_UNAVAILABLE'].includes(safe.code))this.state.connection='blocked';
    if (safe.code === 'SESSION_EXPIRED') this.state.connection = 'expired';
    if(safe.code==='MAIL_SESSION_EXPIRED')this.state.mailConnection.status='expired';
    this.emit();
  }
  private async persist(patch: Partial<Persisted>) {
    const value: Persisted = { version: 1, workflowPreferences:this.state.workflowPreferences, lifecycleQueue:this.state.lifecycleQueue, lifecyclePreferences:this.state.lifecyclePreferences, browserPreferences:this.state.browserPreferences,savedConnections:this.state.savedConnections, settings: this.state.settings, discovery: this.state.discovery, history: this.state.history, lastAttemptAt: this.state.lastAttemptAt, liveHistory: this.state.liveHistory, liveSafetyLock: this.state.liveSafetyLock, ...patch };
    await this.store.save(value);
    Object.assign(this.state, value);
  }
  private async saveLiveRecords(liveHistory:AppState['liveHistory']) {
    const record=liveHistory[0],previous=this.state.liveHistory.find(value=>value.id===record?.id)?.progress;
    await this.persist({liveHistory});
    if(record?.progress&&JSON.stringify(record.progress)!==JSON.stringify(previous)){
      this.state.lifecycleRun={recordId:record.id,stage:record.progress.message,progress:record.progress,active:!!this.workflowController,stopping:this.workflowController?.signal.aborted??false};
    }
    this.emit();
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.assertNotUpdating();
    if (this.state.busy) throw new AppError('BUSY', 'Wait for the current operation or cancel the connection first.');
    const startingProgress=this.state.lifecycleRun;
    this.state.busy = true; this.cancelled = false; this.emit();
    try { return await action(); }
    catch (error) {
      const safe=safeError(error),run=this.state.lifecycleRun;
      if(run&&run!==startingProgress&&run.progress&&run.progress.status!=='uncertain'){
        const record=this.state.liveHistory.find(value=>value.id===run.recordId);
        if(!record||!['deleted','copy-retained','copy-removed'].includes(record.phase)){
          const status=safe.code==='LIFECYCLE_STOPPED'?'stopped':safe.code.includes('UNKNOWN')?'uncertain':'failed';
          if(record){try{await this.live.reportProgress(record.id,record.progress?.step??run.progress.step,status,safe.message);}catch{/* Preserve the original failure if storage is unavailable. */}}
          else{const progress=makeProgress('database','copy',run.progress.step,status,safe.message);this.state.lifecycleRun={...run,stage:progress.message,progress,active:false};}
        }
      }
      this.log(error);throw new AppError(safe.code,safe.message);
    }
    finally { this.state.busy = false; if(this.state.lifecycleRun)this.state.lifecycleRun.active=false; this.emit(); }
  }
  async connect() {
    return this.exclusive(async () => {
      this.live.cancel();
      this.state.connection = 'connecting'; this.emit();
      try {
        const discovery = await this.browser.connect();
        if (this.cancelled) return;
        // Selection belongs to the previous workspace; never apply demo-specific scope to an account.
        const switched = this.state.discovery?.source !== 'odoo';
        await this.persist({ discovery, savedConnections:{...this.state.savedConnections,odoo:true}, ...(switched ? { settings: { ...this.state.settings, monitoringEnabled: false, lifecycleEnabled:false, scope: 'all', databaseIds: [] }, lastAttemptAt: null } : {}) });
        // Persist the successful visible login before trying the chosen mode.
        // A headless challenge must not discard the discovery or require login again.
        await this.browser.applyMode?.();
        this.state.setupRequired=false;this.state.connection = 'connected'; this.state.odooCheckedAt=new Date().toISOString();
      } catch (error) { if (['connecting','reading'].includes(this.state.connection)) this.state.connection = 'disconnected'; throw error; }
    });
  }
  async finishLogin() {
    if (!this.state.busy || this.state.connection !== 'connecting' || !this.browser.finishLogin) throw new AppError('LOGIN_NOT_READY', 'Start Chrome sign-in first.');
    this.browser.finishLogin();
    this.state.connection = 'reading'; this.emit();
  }
  async cancelConnection() { this.live.cancel(); this.cancelled = true; await this.browser.close(); this.state.connection = this.state.discovery?.source === 'demo' ? 'demo' : 'disconnected'; this.emit(); }
  private async discover(): Promise<Discovery> {
    if (this.state.discovery?.source === 'demo') return { ...this.state.discovery, refreshedAt: new Date().toISOString() };
    let discovery:Discovery;
    try{discovery=await this.browser.refresh();}catch(error){this.state.connection='disconnected';throw error;}
    if (this.cancelled) throw new AppError('CANCELLED', 'The read-only operation was cancelled.');
    this.state.setupRequired=false;this.state.connection = 'connected'; this.state.odooCheckedAt=new Date().toISOString();
    return discovery;
  }
  async refresh() { return this.exclusive(async () => { await this.persist({ discovery: await this.discover() }); }); }
  async useDemo() {
    return this.exclusive(async () => {
      this.live.cancel();
      await this.browser.close();
      await this.persist({ savedConnections:{...this.state.savedConnections,odoo:false}, discovery: demoDiscovery(), settings: { ...this.state.settings, monitoringEnabled: false, lifecycleEnabled:false, scope: 'all', databaseIds: [] }, lastAttemptAt: null });
      this.state.connection = 'demo';
    });
  }
  async disconnect() {
    return this.exclusive(async () => {
      this.live.cancel();
      await this.browser.close();
      await this.mailbox.close();
      this.state.mailConnection={status:'disconnected',email:null,checkedAt:null};this.state.odooCheckedAt=null;
      await this.persist({ savedConnections:{odoo:false,mail:false},settings: { ...this.state.settings, monitoringEnabled: false, lifecycleEnabled:false } });
      this.state.connection = this.state.discovery?.source === 'demo' ? 'demo' : 'disconnected';
    });
  }
  async clearSession() {
    return this.exclusive(async () => {
      this.live.cancel();
      await this.browser.close();
      await this.mailbox.close();
      await rm(this.profile, { recursive: true, force: true });
      await rm(this.profile+'-webmail', { recursive: true, force: true });
      this.state.mailConnection={status:'disconnected',email:null,checkedAt:null};this.state.odooCheckedAt=null;
      await this.persist({ savedConnections:{odoo:false,mail:false},settings: { ...this.state.settings, monitoringEnabled: false, lifecycleEnabled:false } });
      this.state.connection = this.state.discovery?.source === 'demo' ? 'demo' : 'disconnected';
    });
  }
  async connectMail(){return this.exclusive(async()=>{
    this.state.mailConnection={status:'connecting',email:null,checkedAt:null};this.emit();
    try{
      const email=await this.mailbox.connect();if(this.cancelled)return;
      await this.persist({savedConnections:{...this.state.savedConnections,mail:true}});
      this.state.mailConnection={status:'connected',email,checkedAt:new Date().toISOString()};
    }catch(error){this.state.mailConnection.status='disconnected';throw error;}
  });}
  async finishMailLogin(){
    if(!this.state.busy||this.state.mailConnection.status!=='connecting')throw new AppError('LOGIN_NOT_READY','Start Viamail sign-in first.');
    this.mailbox.finishLogin();this.state.mailConnection.status='reading';this.emit();
  }
  async cancelMailConnection(){this.cancelled=true;await this.mailbox.close();this.state.mailConnection.status='disconnected';this.emit();}
  private async checkMail(){
    this.state.mailConnection.status='reading';this.emit();
    try{const email=await this.mailbox.check();this.state.mailConnection={status:'connected',email,checkedAt:new Date().toISOString()};}
    catch(error){this.state.mailConnection.status=error instanceof AppError&&error.code==='MAIL_SESSION_EXPIRED'?'expired':'disconnected';this.state.mailConnection.checkedAt=new Date().toISOString();throw error;}
  }
  private async checkSaved(odoo:boolean,mail:boolean){
    if(odoo){
      this.state.connection='reading';this.emit();
      try{
        if(this.browser.check)await this.browser.check();else await this.browser.refresh();
        this.state.connection='connected';this.state.odooCheckedAt=new Date().toISOString();
        await this.persist({savedConnections:{...this.state.savedConnections,odoo:true}});
      }catch(error){this.state.connection='disconnected';this.state.odooCheckedAt=new Date().toISOString();this.log(error);}
    }
    if(mail){try{await this.checkMail();await this.persist({savedConnections:{...this.state.savedConnections,mail:true}});}catch(error){this.log(error);}}
  }
  async restoreConnections(){return this.exclusive(()=>this.checkSaved(this.state.savedConnections.odoo,this.state.savedConnections.mail));}
  async checkConnections(){return this.exclusive(()=>this.checkSaved(this.state.discovery?.source==='odoo'||this.state.savedConnections.odoo,true));}
  async saveBrowserPreferences(input:{headless:boolean}){return this.exclusive(async()=>{
    const parsed=browserPreferencesSchema.safeParse(input);if(!parsed.success)throw new AppError('INVALID_SETTINGS','Choose visible or headless browser mode.');
    this.live.cancel();
    await this.persist({browserPreferences:parsed.data});
    await this.browser.setHeadless?.(parsed.data.headless);await this.mailbox.setHeadless(parsed.data.headless);
    await this.checkSaved(this.state.savedConnections.odoo,this.state.savedConnections.mail);
  });}
  async saveWorkflowPreferences(input: WorkflowPreferences) {
    return this.exclusive(async () => {
      const parsed = workflowPreferencesSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_SETTINGS', typeof input?.copyNameTemplate === 'string' && copyNameTemplateError(input.copyNameTemplate) || 'Choose a whole-number activation email delay from 0 to 60 minutes and a valid copy name template.');
      await this.persist({workflowPreferences:parsed.data});
    });
  }
  async saveSettings(input: Settings) {
    return this.exclusive(async () => {
      const parsed = settingsSchema.safeParse(input);
      if (!parsed.success) throw new AppError('INVALID_SETTINGS', 'Choose a threshold from 0 to 365 days and an interval of 6, 12, or 24 hours.');
      const known = new Set(this.state.discovery?.databases.map(d => d.id));
      if (parsed.data.databaseIds.some(id => !known.has(id))) throw new AppError('INVALID_SELECTION', 'The database selection is out of date. Select databases from the current list.');
      if (parsed.data.scope === 'selected' && parsed.data.databaseIds.length === 0 && (parsed.data.monitoringEnabled||parsed.data.lifecycleEnabled)) throw new AppError('EMPTY_SELECTION', 'Select at least one database or choose All databases before enabling monitoring.');
      if(parsed.data.deleteAfterActivation!==this.state.settings.deleteAfterActivation)this.live.cancel();
      await this.persist({ settings: parsed.data, lastAttemptAt: null });
    });
  }
  async simulate(ids: string[]) {
    return this.exclusive(async () => {
      const parsed = idsSchema.safeParse(ids);
      if (!parsed.success || !this.state.discovery) throw new AppError('INVALID_SELECTION', 'Choose one or more databases from the current list.');
      const databases = [...new Set(parsed.data)].map(id => this.state.discovery!.databases.find(d => d.id === id));
      if (databases.some(d => !d)) throw new AppError('INVALID_SELECTION', 'One selected database is no longer present. Refresh your selection.');
      if (databases.some(d => isProtected(d!.name))) throw new AppError('PROTECTED_DATABASE', 'The accounting database is excluded at your request.');
      const reports: Simulation[] = [];
      for (const db of databases) reports.push(simulate(db!, this.state.discovery, 'manual', this.state.connection === 'connected', new Date(), reports.map(r => r.proposedName), this.state.workflowPreferences.copyNameTemplate));
      await this.persist({ history: [...reports, ...this.state.history] });
      return reports.map(r => r.id);
    });
  }
  async runMonitor() {
    return this.exclusive(async () => {
      // Persist attempted time before network work: failures do not create a tight retry loop.
      await this.persist({ lastAttemptAt: new Date().toISOString() });
      const discovery = await this.discover();
      const matches = dueDatabases(discovery.databases, this.state.settings, this.state.history);
      const reports: Simulation[] = [];
      for (const db of matches) reports.push(simulate(db, discovery, 'automatic', discovery.source === 'odoo' && this.state.connection === 'connected', new Date(), reports.map(r => r.proposedName), this.state.workflowPreferences.copyNameTemplate));
      await this.persist({ discovery, history: [...reports, ...this.state.history] });
      if(this.state.settings.lifecycleEnabled&&discovery.source==='odoo'){
        const due=scheduledCandidates(discovery.databases,this.state.settings,this.state.lifecycleQueue,this.state.liveHistory);
        const reserved=[...discovery.databases.map(db=>db.name),...this.state.liveHistory.map(record=>record.copyName),...this.state.lifecycleQueue.map(job=>job.copyName)];
        const jobs:ScheduledCycle[]=due.map(database=>{
          const existing=this.state.liveHistory.find(record=>record.originalUuid===database.uuid&&!['copy-removed','copy-retained'].includes(record.phase));
          const copyName=existing?.copyName??proposeName(database.name,reserved,new Date(),this.state.workflowPreferences.copyNameTemplate);reserved.push(copyName);
          return {id:crypto.randomUUID(),database,copyName,detectedAt:new Date().toISOString(),status:'pending',recordId:existing?.id??null,message:'Expiry threshold reached. Waiting to run this lifecycle.'};
        });
        await this.persist({lifecycleQueue:[...jobs,...this.state.lifecycleQueue]});
        this.emit();
        if(!this.state.lifecyclePreferences.safeMode){
          for(const job of this.state.lifecycleQueue.filter(job=>job.status==='pending')){
            if(this.cancelled)break;
            if(!discovery.databases.some(db=>db.uuid===job.database.uuid&&matchesLifecycleRule(db,this.state.settings)))continue;
            try{await this.executeScheduled(job.id);}catch(error){this.log(error);break;}
          }
        }
      }
    });
  }
  private completedMessage(id?:string|null){
    return this.state.liveHistory.find(record=>record.id===id)?.phase==='copy-retained'?'Activation and expiry verified. Deletion skipped; both databases retained.':'Lifecycle completed; original deleted and verified copy retained.';
  }
  private scheduledJob(id:string){const job=this.state.lifecycleQueue.find(job=>job.id===id);if(!job||!['pending','attention'].includes(job.status))throw new AppError('LIFECYCLE_BLOCKED','Choose a pending lifecycle from the queue.');return job;}
  private async updateJob(id:string,patch:Partial<ScheduledCycle>){await this.persist({lifecycleQueue:this.state.lifecycleQueue.map(job=>job.id===id?{...job,...patch}:job)});this.emit();}
  async dismissScheduledLifecycle(id:string){return this.exclusive(async()=>{this.scheduledJob(id);this.live.cancel();await this.updateJob(id,{status:'dismissed',message:'Dismissed by the user. This expiration event will not be scheduled again.'});});}
  async runScheduledLifecycle(id:string){return this.exclusive(()=>this.executeScheduled(id));}
  private async executeScheduled(id:string){
    const job=this.scheduledJob(id),mode=this.state.lifecyclePreferences.safeMode?'guided':'automatic';
    // A crash may have saved creation intent before linking it to the queue.
    const record=this.state.liveHistory.find(record=>record.scheduledId===id||record.id===job.recordId);
    try{
    if(record&&record.originalUuid!==job.database.uuid)throw new AppError('LIFECYCLE_BLOCKED','The scheduled database identity changed.');
    await this.checkMail();
    if(mode==='guided'&&!record)return await this.live.prepareDuplicate(job.database.id,job.copyName,mode,{uuid:job.database.uuid!,scheduledId:id});
    await this.updateJob(id,{status:'running',message:'Lifecycle is running. No mutation will be retried.'});
      const review=await this.workflow(async signal=>{
        let recordId=record?.id;
        if(recordId)await this.live.authorizeWorkflow(recordId,mode,id);
        else{
          const prepared=await this.live.prepareDuplicate(job.database.id,job.copyName,mode,{uuid:job.database.uuid!,scheduledId:id});assertRunning(signal);
          recordId=await this.live.commitAutomatic(prepared.ticket);
        }
        if(!recordId)throw new AppError('LIFECYCLE_BLOCKED','No lifecycle record was created.');
        await this.updateJob(id,{recordId});
        return this.finishLifecycle(recordId,mode,signal);
      });
      await this.updateJob(id,{status:review?'pending':'complete',message:review?'Copy verified. Separate deletion confirmation is required.':this.completedMessage(this.state.lifecycleQueue.find(value=>value.id===id)?.recordId)});
      return review;
    }catch(error){await this.updateJob(id,{status:'attention',message:safeError(error).message});throw error;}
  }
  async prepareDuplicate(id:string,name:string){return this.exclusive(()=>this.live.prepareDuplicate(id,name));}
  async prepareDelete(id:string){return this.exclusive(()=>this.live.prepareDelete(id));}
  async saveLifecyclePreferences(input:{safeMode:boolean}){return this.exclusive(async()=>{
    const parsed=lifecyclePreferencesSchema.safeParse(input);if(!parsed.success)throw new AppError('INVALID_SETTINGS','Choose Safe mode on or off.');
    this.live.cancel();
    if(this.state.lifecyclePreferences.safeMode&&!parsed.data.safeMode&&!await this.confirmAutomatic())return;
    await this.persist({lifecyclePreferences:parsed.data});
  });}
  private async workflow<T>(action:(signal:AbortSignal)=>Promise<T>){
    const controller=new AbortController();this.workflowController=controller;
    const progress=makeProgress('database','copy','preparing','running');
    this.state.lifecycleRun={recordId:null,stage:progress.message,progress,stopping:false,active:true};this.emit();
    try{return await action(controller.signal);}
    finally{this.workflowController=null;if(this.state.lifecycleRun)this.state.lifecycleRun.active=false;this.emit();}
  }
  async stopLifecycle(){this.cancelled=true;this.workflowController?.abort();this.live.cancel();if(this.state.lifecycleRun){this.state.lifecycleRun.stopping=true;this.state.lifecycleRun.stage='Stopping after any action already submitted';this.emit();}}
  private async finishLifecycle(id:string,mode:'guided'|'automatic',signal:AbortSignal){
    try{return await new LifecycleRunner(this.live,{signal,wait:this.runnerWait,
      progress:(stage,recordId)=>{this.state.lifecycleRun={recordId,stage,progress:this.live.getRecord(recordId).progress,active:true,stopping:signal.aborted};this.emit();},
      readLink:r=>this.mailbox.findActivationLink({copyName:r.copyName,email:r.activation!.userEmail,createdAt:r.createdAt})}).finish(id,mode);
    }finally{await this.mergeLiveMetadata(id);}
  }
  async runLifecycle(id:string,name:string){return this.exclusive(async()=>{
    // Turning Safe mode off never starts work. Only this explicit invocation does.
    await this.checkMail();
    if(this.state.lifecyclePreferences.safeMode)return this.live.prepareDuplicate(id,name,'guided');
    return this.workflow(async signal=>{
      const review=await this.live.prepareDuplicate(id,name,'automatic');assertRunning(signal);
      const recordId=await this.live.commitAutomatic(review.ticket);
      if(!recordId)return null;
      return this.finishLifecycle(recordId,'automatic',signal);
    });
  });}
  async continueLifecycle(id:string){return this.exclusive(async()=>{
    await this.checkMail();const mode=this.state.lifecyclePreferences.safeMode?'guided':'automatic';
    return this.workflow(async signal=>{await this.live.authorizeWorkflow(id,mode);assertRunning(signal);return this.finishLifecycle(id,mode,signal);});
  });}
  async confirmLive(input:LiveConfirmation){return this.exclusive(async()=>{
    const review=this.live.pendingReview();
    const commit=async(signal?:AbortSignal)=>{
      if(review?.scheduledId)await this.updateJob(review.scheduledId,{status:'running',message:'Awaiting the separate action confirmation.'});
      try{
        const id=await this.live.commit(input);
        if(!id){
          if(review){const progress=makeProgress(review.original.name,review.copyName,review.action==='duplicate'?'duplicating':'awaiting-deletion','stopped','Confirmation cancelled before submission. No new database action was sent.');this.state.lifecycleRun={recordId:review.recordId,stage:progress.message,progress,active:false,stopping:false};if(review.recordId)await this.live.reportProgress(review.recordId,progress.step,progress.status,progress.detail);}
          if(review?.scheduledId)await this.updateJob(review.scheduledId,{status:'pending',message:'Confirmation cancelled. No new action submitted.'});return null;}
        await this.mergeLiveMetadata(id);
        if(review?.scheduledId)await this.updateJob(review.scheduledId,{recordId:id});
        const next=review?.workflow==='guided'&&review.action==='duplicate'&&signal?await this.finishLifecycle(id,'guided',signal):null;
        if(review?.scheduledId)await this.updateJob(review.scheduledId,{status:next?'pending':'complete',message:next?'Copy verified. Separate deletion confirmation is required.':this.completedMessage(id)});
        return next;
      }catch(error){if(review?.scheduledId)await this.updateJob(review.scheduledId,{status:'attention',message:safeError(error).message});throw error;}
    };
    return review?.workflow==='guided'&&review.action==='duplicate'?this.workflow(commit):commit();
  });}
  async cancelLive(){if(!this.workflowController)this.live.cancel();}
  async verifyCopy(id:string){return this.exclusive(async()=>{try{await this.live.verifyCopy(id);}finally{await this.mergeLiveMetadata(id);}});}
  async closeRemovedCopy(input:{recordId:string;removedByUser:true}){return this.exclusive(async()=>{await this.live.closeRemovedCopy(input);await this.mergeLiveMetadata(input.recordId);});}
  async retainCopy(id:string){return this.exclusive(async()=>{
    await this.live.retainCopy(id);
    const record=this.live.getRecord(id);
    const job=this.state.lifecycleQueue.find(job=>job.id===record.scheduledId||job.recordId===id);
    if(job)await this.updateJob(job.id,{status:'dismissed',message:'Cycle closed with both databases retained. No deletion requested.'});
    await this.mergeLiveMetadata(id);
  });}
  async activateCopy(id:string){return this.exclusive(async()=>{const record=await this.live.startActivation(id);await this.mergeLiveMetadata(id);if(record)await this.checkMail();});}
  async readActivationEmail(id:string){return this.exclusive(async()=>{try{await this.live.completeActivation(id,r=>this.mailbox.findActivationLink({copyName:r.copyName,email:r.activation!.userEmail,createdAt:r.createdAt}));}finally{await this.mergeLiveMetadata(id);}});}
  private async mergeLiveMetadata(id:string){
    if(this.state.discovery?.source!=='odoo')return;
    const rows=new Map(this.state.discovery.databases.map(d=>[d.id,d]));
    let settings=this.state.settings;
    for(const record of this.state.liveHistory.filter(r=>r.id===id)){
      if(record.copy&&record.copyUuid&&record.phase!=='copy-removed')rows.set(record.copy.id,record.copy);
      if(record.phase==='copy-removed')rows.delete(`https://${record.copyName}.odoo.com`);
      if(record.phase==='deleted'){
        rows.delete(record.original.id);
        if(record.copy&&settings.databaseIds.includes(record.original.id))settings={...settings,databaseIds:[...new Set(settings.databaseIds.map(value=>value===record.original.id?record.copy!.id:value))]};
      }
    }
    await this.persist({settings,discovery:{...this.state.discovery,databases:[...rows.values()]}});
  }
  async dispose() { this.workflowController?.abort(); this.live.cancel(); clearInterval(this.timer); await this.browser.close(); await this.mailbox.close(); }
}

import { chromium, type Browser } from 'playwright';
import type { Discovery } from '../src/shared/types';
import { AppError } from './errors';
import { ManualChrome } from './chrome-login';
import { MetadataReader } from './reader';
import { parseDatabaseList, requireDatabaseSession } from './metadata';
import { LOGIN_URL } from './policy';
import { assertUnprotected, type LiveInspection } from './live-contract';
import { isProtected } from '../src/shared/live';
import type { SessionVault } from './session-vault';
import { connectionTimeout } from './timeout';
import { BackgroundPages, enableBackgroundPages } from './background-pages';
export class ReadOnlyBrowser {
  private chrome: ManualChrome;
  private browser: Browser | null = null;
  private reader: MetadataReader | null = null;
  private finish: (() => void) | null = null;
  private cancel: (() => void) | null = null;
  private cancelled = false;
  private headless = false;
  private runningHeadless = false;
  constructor(profile: string, _browserRoot: string, private diagnostic: (error: AppError) => void, private vault?:SessionVault) { this.chrome = new ManualChrome(profile); }
  get isRunning(){return this.chrome.isRunning;}
  async setHeadless(value:boolean){if(this.headless===value)return;await this.close();this.headless=value;}
  private modeError(error:unknown){return this.runningHeadless&&error instanceof AppError&&error.code==='SESSION_EXPIRED'&&error.message.includes('HTTP 403')?new AppError('HEADLESS_BLOCKED','Odoo rejected background access (HTTP 403). Your saved sign-in is retained. Choose visible Chrome to check whether Odoo requires verification.'):error;}
  async check(){try{await connectionTimeout(async()=>{await this.ensureReader();parseDatabaseList(await this.reader!.list());await this.saveSession();},'Odoo connection check timed out. Reconnect Odoo or try visible Chrome mode.');}catch(error){await this.close();throw this.modeError(error);}}
  async applyMode(){if(this.headless){await this.close();await this.check();}}
  private async saveSession(){if(this.browser?.isConnected())await this.vault?.saveOdoo(this.browser.contexts()[0]);}
  finishLogin() {
    if (!this.finish) throw new AppError('LOGIN_NOT_READY', 'Wait for Chrome to open before reading the databases.');
    this.finish(); this.finish = null;
  }
  async connect(): Promise<Discovery> {
    await this.close(); this.cancelled = false;
    try {
      this.runningHeadless=false;const endpoint = await this.chrome.launch(LOGIN_URL);
      this.assertActive();
      await new Promise<void>((resolve,reject) => {
        const cleanup = () => { clearTimeout(timer); clearInterval(closed); this.finish=null; this.cancel=null; };
        const timer = setTimeout(() => { cleanup(); reject(new AppError('LOGIN_TIMEOUT','Sign-in did not finish within 15 minutes. Start it again when ready.')); },15*60*1000);
        const closed = setInterval(() => { if(!this.chrome.isRunning) this.cancel?.(); },1000);
        this.finish=()=>{cleanup();resolve();};
        this.cancel=()=>{cleanup();reject(new AppError('LOGIN_CANCELLED','Chrome sign-in was cancelled.'));};
      });
      this.assertActive();
      await this.attach(endpoint);
      const discovery=await this.collect();await this.saveSession();
      return discovery;
    } catch(error) { await this.close(); throw error; }
  }
  async refresh(): Promise<Discovery> {
    this.cancelled=false;
    try {
      await this.ensureReader();
      const discovery=await this.collect();await this.saveSession();return discovery;
    } catch(error) { await this.close(); throw this.modeError(error); }
  }
  private async ensureReader(){
    if(this.browser?.isConnected()&&this.reader&&this.chrome.isRunning)return;
    await this.close();this.cancelled=false;
    this.runningHeadless=this.headless;const endpoint=await this.chrome.launch('about:blank',this.headless?'background':false);
    this.assertActive();await this.attach(endpoint,true);
  }
  private assertActive() { if(this.cancelled) throw new AppError('LOGIN_CANCELLED','The metadata read was cancelled.'); }
  private async attach(endpoint: string, restore=false) {
    if(this.runningHeadless)enableBackgroundPages();
    this.browser=await chromium.connectOverCDP(endpoint,{timeout:15000});
    const context=this.browser.contexts()[0];
    if(!context) throw new AppError('CHROME_CONNECTION','The dedicated Chrome session could not be read.');
    const background=this.runningHeadless?await BackgroundPages.create(this.browser,context):null;
    this.reader=new MetadataReader(context,background?()=>background.newPage():undefined); await this.reader.install(background?()=>background.keepAlive():undefined);
    if(restore)await this.vault?.restoreOdoo(context);
    if(background)return;
    const idle=await context.newPage();
    await idle.setContent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; form-action \'none\'"><title>Lifecycle Manager — read only</title><h1>Connected to Lifecycle Manager</h1><p>Return to Lifecycle Manager to view your databases. Database controls are unavailable here. Browser visibility can be changed in Settings.</p>');
  }
  private async collect(): Promise<Discovery> {
    const reader=this.reader!;
    const now=new Date();
    const listed=parseDatabaseList(await reader.list(),now);
    reader.allowDatabases(listed.map(row=>row.database.url!));
    const warnings: string[]=[];
    for(const row of listed) {
      this.assertActive();
      if(isProtected(row.database.name)) { row.database.expirationEvidence='Excluded at your request. No database session or Manage page was read.'; continue; }
      try {
        try { requireDatabaseSession(row.database,await reader.session(row.database.url!)); }
        catch(error) {
          if(!(error instanceof AppError) || !['SESSION_EXPIRED','MANAGE_AUTH_REQUIRED'].includes(error.code)) throw error;
          await reader.authenticate(row.database.url!,row.uuid,row.database.name);
          requireDatabaseSession(row.database,await reader.session(row.database.url!));
        }
        row.database=await reader.manage(row.database,row.uuid);
        if(!row.database.expiresAt && row.database.remainingDays==null) warnings.push(`${row.database.name}: Manage page read successfully; no expiration date or days-remaining banner was shown.`);
      } catch(error) {
        reader.assertSafe();
        if(error instanceof AppError && error.code==='SAFETY_STOP') throw error;
        const reason=error instanceof AppError ? error.message : 'The database metadata read could not finish.';
        if(!row.database.expiresAt) {row.database.expirationEvidence=`Manage expiry unavailable: ${reason}`;warnings.push(`${row.database.name}: ${reason} Expiration remains Unknown.`);}
      }
    }
    reader.assertSafe(); this.assertActive();
    return {databases:listed.map(row=>row.database),refreshedAt:now.toISOString(),source:'odoo',coverage:'visible-list',pages:1,warnings};
  }
  // Live preflight reads only the selected database, never every Manage page.
  private activeReader(){if(!this.reader||!this.browser?.isConnected())throw new AppError('SESSION_EXPIRED','Connect to Odoo before preparing a live action.');return this.reader;}
  activation(target:LiveInspection){return this.activeReader().activation(target);}
  sendActivation(target:LiveInspection,email:string){return this.activeReader().sendActivation(target,email);}
  activateFromEmail(target:LiveInspection,link:string){return this.activeReader().activateFromEmail(target,link);}
  async liveList(){return parseDatabaseList(await this.activeReader().list());}
  async inspectLive(id:string):Promise<LiveInspection>{
    assertUnprotected(id);
    const reader=this.activeReader();const listed=await this.liveList();
    const row=listed.find(r=>r.database.id===id);
    if(!row)throw new AppError('DATABASE_MISSING','The selected database is no longer in the account list.');
    assertUnprotected(row.database.name);reader.allowDatabases([row.database.url!]);
    try{requireDatabaseSession(row.database,await reader.session(row.database.url!));}
    catch(error){if(!(error instanceof AppError)||error.code!=='SESSION_EXPIRED')throw error;await reader.authenticate(row.database.url!,row.uuid,row.database.name);requireDatabaseSession(row.database,await reader.session(row.database.url!));}
    return reader.inspectLive(row.database,row.uuid,row.parentUuid);
  }
  duplicateLive(target:LiveInspection,name:string){return this.activeReader().duplicateLive(target,name);}
  checkCopyName(name:string,original:string){return this.activeReader().checkCopyName(name,original);}
  deleteLive(target:LiveInspection){return this.activeReader().deleteLive(target);}
  async close() {
    this.cancelled=true; this.cancel?.();this.cancel=null;this.finish=null;this.reader=null;
    const browser=this.browser;this.browser=null;
    await this.chrome.close();
    if(browser) await browser.close().catch(()=>{});
  }
}

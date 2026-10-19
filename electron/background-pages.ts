import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { AppError } from './errors';

// Chrome's supported hidden targets have type "other". The pinned Playwright
// version includes this adapter; integration tests verify its routing and cleanup.
// This changes Playwright's local attachment handling, not the browser identity.
export function enableBackgroundPages() { process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1'; }

export class BackgroundPages {
  private anchor: Page | null = null;
  private constructor(private session: CDPSession, private context: BrowserContext, private contextId?: string) {}
  static async create(browser: Browser, context: BrowserContext, contextId?: string) {
    return new BackgroundPages(await browser.newBrowserCDPSession(), context, contextId);
  }
  // Chrome requires an existing frame when creating its first hidden target.
  // Keep one guarded, inert anchor until the owned browser exits so the first
  // request after an idle period is just as reliable as subsequent requests.
  async keepAlive(){
    if(this.anchor&&!this.anchor.isClosed())return;
    // The macOS launcher confirms its owned application is hidden before this
    // background blank window is created. No remote document is loaded here.
    const bootstrap=await this.open(false);
    try{this.anchor=await this.newPage();}finally{await bootstrap.close();}
  }
  newPage(): Promise<Page> {return this.open(true);}
  private async open(hidden:boolean): Promise<Page> {
    let targetId: string | undefined;
    // Register before creating the target. Requests are serialized by the reader;
    // any unrelated page arriving first fails the identity check below.
    const ready = this.context.waitForEvent('page', {timeout: 10000});
    try {
      const [created, page] = await Promise.all([
        this.session.send('Target.createTarget', {url: 'about:blank', ...(hidden?{hidden:true}:{}), background: true, ...(this.contextId ? {browserContextId: this.contextId} : {})}).then(result => {targetId = result.targetId; return result;}),
        ready,
      ]);
      const pageSession = await this.context.newCDPSession(page);
      try {
        const {targetInfo} = await pageSession.send('Target.getTargetInfo');
        if (targetInfo.targetId !== created.targetId || targetInfo.type !== (hidden?'other':'page')) throw new Error('Hidden target unavailable');
      } finally { await pageSession.detach(); }
      // A hidden target must have no native browser window. Never silently fall
      // back to visible tabs if Chrome changes its target implementation.
      let hasWindow = false;
      if(hidden)try { await this.session.send('Browser.getWindowForTarget', {targetId}); hasWindow = true; } catch {}
      if (hasWindow) throw new Error('Unexpected browser window');
      return page;
    } catch (cause) {
      if (targetId) await this.session.send('Target.closeTarget', {targetId}).catch(() => {});
      const failure=new AppError('BACKGROUND_UNAVAILABLE', 'Chrome could not create a background reader. Your saved sign-in is retained. Update Chrome or choose visible mode.');
      failure.cause=cause; // Native diagnostic only; safeError exposes code/message.
      throw failure;
    }
  }
}

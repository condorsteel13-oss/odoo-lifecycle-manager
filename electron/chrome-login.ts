import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './errors';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
type ChromeDisplay = boolean | 'background';
// Dedicated app-owned profile only. Never attach to, copy, or inspect a personal profile.
export class ManualChrome {
  private process: ChildProcess | null = null;
  private endpoint: string | null = null;
  private display: ChromeDisplay = false;
  constructor(readonly profile: string) {}
  get isRunning() { return !!this.process && this.process.exitCode === null && this.process.signalCode === null; }
  async launch(url: string, display: ChromeDisplay = false): Promise<string> {
    if (this.isRunning && this.endpoint) {
      if(this.display!==display)throw new AppError('CHROME_MODE','Close the current browser before changing its display mode.');
      return this.endpoint;
    }
    if (!existsSync(CHROME)) throw new AppError('CHROME_MISSING', 'Install Google Chrome in Applications to use manual sign-in.');
    await mkdir(join(this.profile, 'Default'), { recursive: true, mode: 0o700 });
    await chmod(this.profile, 0o700);
    const path = join(this.profile, 'Default', 'Preferences');
    let prefs: Record<string, any> = {};
    try { prefs = JSON.parse(await readFile(path, 'utf8')); } catch {}
    prefs.credentials_enable_service = false;
    prefs.profile = { ...prefs.profile, password_manager_enabled: false };
    await writeFile(path, JSON.stringify(prefs), { mode: 0o600 });
    // A nonzero, OS-assigned loopback port; Chrome's debugging service is never public.
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port)); });
    });
    // Launch Services hides only this new Chrome instance before presenting its
    // blank bootstrap window. The reader replaces it with windowless targets.
    if(display==='background'&&url!=='about:blank')throw new AppError('CHROME_MODE','Background Chrome starts with an empty reader only.');
    const displayArgs=display==='background'?['--no-startup-window']:display?['--headless=new',url]:['--new-window',url];
    const resources=(process as NodeJS.Process&{resourcesPath?:string}).resourcesPath;
    const bundled=resources?join(resources,'chrome-background'):'';
    const helper=existsSync(bundled)?bundled:join(process.cwd(),'dist-electron/chrome-background');
    if(display==='background'&&!existsSync(helper))throw new AppError('BACKGROUND_UNAVAILABLE','The background Chrome launcher is missing. Reinstall the app or select visible mode.');
    const child = spawn(display==='background'?helper:CHROME, [`--user-data-dir=${this.profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-save-password-bubble', ...displayArgs], { stdio: display==='background'?['ignore','pipe','ignore']:'ignore' });
    this.display = display;
    child.on('error', () => {});
    this.process = child;
    if(display==='background'){
      try{await new Promise<void>((resolve,reject)=>{
        const finish=(error?:Error)=>{clearTimeout(timer);child.stdout?.off('data',ready);child.off('exit',stopped);child.off('error',failed);error?reject(error):resolve();};
        const ready=(data:Buffer)=>{if(data.toString().includes('ready'))finish();};
        const stopped=()=>finish(new AppError('BACKGROUND_UNAVAILABLE',`Chrome could not start hidden (launcher ${child.exitCode??'timeout'}). Your saved session is retained.`));
        const failed=()=>stopped();const timer=setTimeout(stopped,10000);
        child.stdout?.on('data',ready);child.once('exit',stopped);child.once('error',failed);
      });}catch(error){await this.close();throw error;}
    }
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (this.process !== child || (child.exitCode !== null || child.signalCode !== null)) throw new AppError('LOGIN_CANCELLED', 'The app’s Chrome window was closed. Start sign-in again.');
      try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
        const info = await response.json() as { webSocketDebuggerUrl?: string };
        const ws = new URL(info.webSocketDebuggerUrl ?? '');
        if (ws.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(ws.hostname) && ws.port === String(port)) { this.endpoint = endpoint; return endpoint; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await this.close();
    throw new AppError('CHROME_LAUNCH', 'The dedicated Chrome window could not start. Close its previous window and try again.');
  }
  async close() {
    const child = this.process; this.process = null; this.endpoint = null;
    if (!child || (child.exitCode !== null || child.signalCode !== null)) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer=setTimeout(()=>{ child.off('exit',done); resolve(); },5000);
      const done=()=>{clearTimeout(timer);resolve();}; child.once('exit',done);
    });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

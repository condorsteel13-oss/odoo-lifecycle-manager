import { updateDisk } from './update-disk';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { UpdateState } from '../src/shared/updates';
import { AppError } from './errors';
import { downloadRelease, latestRelease, updateError, verifyDownload, type UpdateRelease } from './update-release';
import { BUNDLE_NAME, extractUpdate, validateBundle } from './update-archive';
const { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } = updateDisk.promises;
const { constants } = updateDisk;

export interface Installer { commit(): Promise<void>; cancel(): void }
export interface UpdateDependencies {
  latest(current: string, signal: AbortSignal): Promise<UpdateRelease | null>;
  download(release: UpdateRelease, file: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void>;
  stage(file: string, destination: string, version: string): Promise<string>;
  prepare(bundle: string, jobDirectory: string, version: string): Promise<Installer>;
  blockReason(): string | null;
  acquire(): void;
  release(): void;
  closeIdleConnections(): Promise<void>;
  quit(): void;
}
export class AppUpdater {
  private value: UpdateState;
  private releaseInfo: UpdateRelease | null = null;
  private downloadFile: string | null = null;
  private directory: string | null = null;
  private active = false;
  private abort = new AbortController();
  private timer?: NodeJS.Timeout;
  private startup?: NodeJS.Timeout;
  constructor(private root: string, version: string, supported: boolean, private publish: (state: UpdateState) => void, private deps: UpdateDependencies) {
    this.value = { currentVersion: version, latestVersion: null, automatic: true, supported, status: 'idle', percent: 0, checkedAt: null, message: supported ? 'Updates are checked automatically while the app is open.' : 'Update downloads are available in the packaged Mac app.', installBlockReason: null };
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Only old, app-owned downloads are discarded. A just-launched helper may still be exiting.
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^download-[a-zA-Z0-9]{6}$/.test(entry.name)) {
        const path = join(this.root, entry.name);
        try { if (Date.now() - (await stat(path)).mtimeMs > 24 * 60 * 60 * 1000) await rm(path, { recursive: true, force: true }); } catch { /* Cleanup must not block startup. */ }
      }
    }
    try { const preferences = JSON.parse(await readFile(join(this.root, 'preferences.json'), 'utf8')); if (typeof preferences.automatic === 'boolean') this.value.automatic = preferences.automatic; } catch { /* Fresh or invalid preferences use the safe default: never restart automatically. */ }
    // A prior helper reports only a fixed message, never account information.
    try { const result = JSON.parse(await readFile(join(this.root, 'result.json'), 'utf8')); if (result.status === 'failed') this.value.message = 'The previous installation did not finish. Your previous app was retained. Check permissions and try again.'; await rm(join(this.root, 'result.json'), { force: true }); } catch { /* No previous installer result. */ }
    this.emit();
    if (this.value.supported) {
      this.startup = setTimeout(() => { if (this.value.automatic) void this.check().catch(() => {}); }, 15000);
      this.timer = setInterval(() => { if (this.value.automatic && !this.active && this.value.status !== 'ready') void this.check().catch(() => {}); }, 6 * 60 * 60 * 1000);
      this.startup.unref(); this.timer.unref();
    }
  }
  state(): UpdateState { return { ...this.value, installBlockReason: this.deps.blockReason() }; }
  emit() { this.publish(this.state()); }
  private change(patch: Partial<UpdateState>) { Object.assign(this.value, patch); this.emit(); }
  get installing() { return ['preparing', 'installing'].includes(this.value.status); }
  async setAutomatic(enabled: unknown) {
    if (typeof enabled !== 'boolean') throw updateError('Choose whether to download updates automatically.');
    if (this.active) throw updateError('Wait for the current update operation to finish.');
    const temporary = join(this.root, 'preferences.tmp');
    await writeFile(temporary, JSON.stringify({ automatic: enabled }), { mode: 0o600 });
    await rename(temporary, join(this.root, 'preferences.json'));
    this.change({ automatic: enabled });
  }
  private async operation(action: () => Promise<void>) {
    if (!this.value.supported) throw updateError('Use the packaged Mac app to download updates.');
    if (this.active) throw updateError('An update operation is already running.');
    this.active = true;
    try { await action(); }
    catch (error) {
      const message = error instanceof AppError ? error.message : 'The update could not finish. Check your internet connection, free space, and folder permissions, then try again.';
      this.change({ status: this.downloadFile ? 'ready' : 'error', message });
      throw updateError(message);
    } finally { this.active = false; }
  }
  async check() {
    if (this.value.status === 'ready') { this.emit(); return; }
    await this.operation(async () => {
      this.change({ status: 'checking', message: 'Checking GitHub for a new release…', percent: 0 });
      this.releaseInfo = await this.deps.latest(this.value.currentVersion, AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]));
      this.change({ latestVersion: this.releaseInfo?.version ?? null, checkedAt: new Date().toISOString(), status: this.releaseInfo ? 'available' : 'idle', message: this.releaseInfo ? `Version ${this.releaseInfo.version} is available.` : 'You have the latest release.' });
      if (this.releaseInfo && this.value.automatic) await this.fetchUpdate();
    });
  }
  async download() { await this.operation(() => this.fetchUpdate()); }
  private async fetchUpdate() {
    if (!this.releaseInfo) throw updateError('Check for a new release first.');
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.downloadFile = null;
    this.directory = await mkdtemp(join(this.root, 'download-'));
    const file = join(this.directory, 'update.zip');
    this.change({ status: 'downloading', percent: 0, message: `Downloading version ${this.releaseInfo.version}…` });
    await this.deps.download(this.releaseInfo, file, AbortSignal.any([this.abort.signal, AbortSignal.timeout(20 * 60000)]), percent => this.change({ percent }));
    this.downloadFile = file;
    this.change({ status: 'ready', percent: 100, message: `Version ${this.releaseInfo.version} is ready. Restart to install when your work is finished.` });
  }
  async install() {
    await this.operation(async () => {
      if (!this.releaseInfo || !this.downloadFile || !this.directory) throw updateError('Download an update before installing it.');
      // Gate twice: immediately, then atomically after potentially lengthy archive extraction.
      const blocked = this.deps.blockReason(); if (blocked) throw updateError(blocked);
      this.change({ status: 'preparing', message: 'Verifying and preparing the downloaded app…' });
      let stage: string | undefined, installer: Installer | undefined, locked = false;
      let phase = 'creating a temporary install folder';
      try {
        stage = await mkdtemp(join(this.directory, 'stage-'));
        phase = 'checking the downloaded update';
        await verifyDownload(this.downloadFile, this.releaseInfo);
        phase = 'extracting and validating the new app';
        const bundle = await this.deps.stage(this.downloadFile, join(stage, 'extracted'), this.releaseInfo.version);
        phase = 'checking that no lifecycle started';
        this.deps.acquire(); locked = true;
        phase = 'starting the installer helper';
        installer = await this.deps.prepare(bundle, stage, this.releaseInfo.version);
        phase = 'closing idle browser sessions';
        await this.deps.closeIdleConnections();
        phase = 'handing the app over to the installer';
        this.change({ status: 'installing', message: 'Restarting to install the verified update…' });
        await installer.commit();
        this.deps.quit();
      } catch (error) {
        try { installer?.cancel(); } catch { /* Preserve the original install failure. */ }
        if (locked) this.deps.release();
        if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
        if (error instanceof AppError) throw error;
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : '';
        throw updateError(`Local installation failed while ${phase}${code}. The current app is unchanged. Check Applications permissions and available disk space, then try again.`);
      }
    });
  }
  dispose() { clearTimeout(this.startup); clearInterval(this.timer); this.abort.abort(); }
}

export async function installationLocation(bundle: string, home: string) {
  const allowed = [join('/Applications', BUNDLE_NAME), join(home, 'Applications', BUNDLE_NAME)];
  if (!allowed.includes(resolve(bundle))) return 'Move the app into Applications before installing updates.';
  try {
    if (await realpath(bundle) !== resolve(bundle)) return 'Open the app directly from Applications to install updates.';
    await access(dirname(bundle), constants.W_OK);
  } catch { return 'This Applications folder is not writable. Install the app in your personal Applications folder.'; }
  return null;
}
export async function prepareInstaller(options: { helper: string; bundle: string; currentVersion: string; root: string }, source: string, jobDirectory: string, version: string): Promise<Installer> {
  const helper = join(jobDirectory, 'installer'), job = join(jobDirectory, 'job.json');
  await copyFile(options.helper, helper); await chmod(helper, 0o700);
  await writeFile(job, JSON.stringify({ source, target: options.bundle, currentVersion: options.currentVersion, version, parentPID: process.pid, result: join(options.root, 'result.json') }), { mode: 0o600 });
  return new Promise((resolveInstaller, reject) => {
    const child = spawn(helper, [job], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false, ready = false;
    let accepted: (() => void) | undefined, rejected: (() => void) | undefined;
    const fail = () => { ready = false; rejected?.(); if (!settled) { settled = true; clearTimeout(timeout); child.stdin.destroy(); child.kill('SIGTERM'); reject(updateError('The installer could not prepare the update. Check Applications permissions and free disk space.')); } };
    const timeout = setTimeout(fail, 120000);
    child.on('error', fail); child.on('exit', () => { ready = false; fail(); }); child.stdin.on('error', fail);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 100) return fail();
      if (output.includes('ACCEPTED\n')) accepted?.();
      if (!settled && output.includes('READY\n')) {
        settled = true; ready = true; clearTimeout(timeout);
        resolveInstaller({
          commit() {
            return new Promise<void>((resolveCommit, rejectCommit) => {
              if (!ready || child.exitCode !== null || child.stdin.destroyed) return rejectCommit(updateError('The installer stopped before restart. Try again.'));
              const acknowledgement = setTimeout(() => fail(), 5000);
              rejected = () => { clearTimeout(acknowledgement); rejectCommit(updateError('The installer did not acknowledge the update. The app will stay open.')); };
              accepted = () => { clearTimeout(acknowledgement); rejected = undefined; accepted = undefined; child.stdout.destroy(); child.unref(); resolveCommit(); };
              child.stdin.end('INSTALL\n');
            });
          },
          cancel() { child.stdin.destroy(); child.stdout.destroy(); child.kill('SIGTERM'); child.unref(); },
        });
      }
    });
  });
}
export const productionUpdateDownloads = {
  latest: latestRelease, download: downloadRelease,
  async stage(file: string, destination: string, version: string) { const bundle = await extractUpdate(file, destination); await validateBundle(bundle, version); return bundle; },
};

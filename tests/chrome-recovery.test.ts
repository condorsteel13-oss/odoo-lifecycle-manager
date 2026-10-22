import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
const exec = promisify(execFile);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let root: string, helper: string, background: string, runner: string;
const cleanup: (() => Promise<void>)[] = [];
const testBrowserPids = new Set<number>();
function running(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function freePort() { return new Promise<number>((done, reject) => { const server = createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : done(port)); }); }); }
async function invoke(action: string, profile: string, token: string, port: number) {
  try { return JSON.parse((await exec(helper, [action, profile, token, String(port)], { timeout: 10000 })).stdout); }
  catch (error) { if (typeof (error as any).stdout === 'string' && (error as any).stdout.startsWith('{')) return JSON.parse((error as any).stdout); throw error; }
}
async function fixture() {
  const dir = await mkdtemp(join(root, 'case-')), profile = join(dir, 'chrome-profile-webmail');
  await mkdir(profile);
  await writeFile(join(profile, 'saved-session.fixture'), 'retained');
  cleanup.push(async () => {
    try {
      const pid = Number((await readlink(join(profile, 'SingletonLock'))).split('-').at(-1));
      if (testBrowserPids.has(pid)) {
        if (running(pid)) process.kill(pid, 'SIGTERM');
        await expect.poll(() => running(pid), { timeout: 6000 }).toBe(false);
      }
    } catch { /* No test browser remains. */ }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, profile, port: await freePort(), token: randomUUID() };
}
async function ready(port: number) {
  await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) })).ok; } catch { return false; } }, { timeout: 10000 }).toBe(true);
}
const flags = (profile: string, port: number) => [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking'];
async function orphan(profile: string, port: number, token: string, legacy = false) {
  const program = `const {execFileSync,spawn}=require('node:child_process');
    const [helper,profile,port,token,chrome,legacy]=process.argv.slice(1);
    if(legacy!=='true')execFileSync(helper,['acquire',profile,token,port]);
    const child=spawn(chrome,['--user-data-dir='+profile,'--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{detached:true,stdio:'ignore'});child.unref();
    (async()=>{for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:'+port+'/json/version')).ok){console.log(JSON.stringify({pid:child.pid,owner:process.pid}));process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,100));}process.exit(2)})()`;
  const result = JSON.parse((await exec(process.execPath, ['-e', program, helper, profile, String(port), token, CHROME, String(legacy)], { timeout: 15000 })).stdout) as { pid: number; owner: number };
  testBrowserPids.add(result.pid);
  return result;
}

describe.skipIf(process.platform !== 'darwin' || !existsSync(CHROME))('native Chrome ownership and abandoned-process recovery (empty temporary profiles only)', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'odoo-chrome-recovery-test-')));
    await mkdir(join(root, 'dist-electron'));
    helper = join(root, 'dist-electron/chrome-recovery'); background = join(root, 'chrome-background'); runner = join(root, 'runner.cjs');
    const cache = resolve('dist-electron/swift-module-cache');
    execFileSync('xcrun', ['swiftc', 'native/chrome-recovery.swift', '-D', 'CHROME_RECOVERY_TESTING', '-module-cache-path', cache, '-o', helper], { timeout: 60000 });
    execFileSync('xcrun', ['swiftc', 'native/chrome-background.swift', '-module-cache-path', cache, '-o', background], { timeout: 60000 });
    await build({ stdin: { contents: `import {ManualChrome} from './electron/chrome-login';
      import {readlink} from 'node:fs/promises';
      (async()=>{const [profile,mode]=process.argv.slice(2);const chrome=new ManualChrome(profile);await chrome.launch('about:blank',true);const pid=Number((await readlink(profile+'/SingletonLock')).split('-').at(-1));if(mode==='close')await chrome.close();console.log(JSON.stringify({pid}));process.exit(0)})().catch(e=>{console.error(e.message);process.exit(1)});`, resolveDir: resolve('.'), sourcefile: 'chrome-recovery-runner.ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: runner });
  }, 65000);
  afterEach(async () => { for (const task of cleanup.splice(0)) await task(); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('reconnects automatically after the owner exits, then closes cleanly without losing saved profile data', async () => {
    const f = await fixture();
    const first = JSON.parse((await exec(process.execPath, [runner, f.profile, 'abandon'], { cwd: root, timeout: 15000 })).stdout);
    testBrowserPids.add(first.pid);
    expect(running(first.pid)).toBe(true);
    const second = JSON.parse((await exec(process.execPath, [runner, f.profile, 'close'], { cwd: root, timeout: 20000 })).stdout);
    expect(second.pid).not.toBe(first.pid);
    expect(running(first.pid)).toBe(false); expect(running(second.pid)).toBe(false);
    expect(existsSync(join(f.profile, '.lifecycle-browser-owner.json'))).toBe(false);
    expect(await readFile(join(f.profile, 'saved-session.fixture'), 'utf8')).toBe('retained');
  }, 30000);

  it('recovers a legacy orphan with an exact dedicated profile and loopback debug port', async () => {
    const f = await fixture(), old = await orphan(f.profile, f.port, f.token, true);
    expect(await invoke('acquire', f.profile, f.token, f.port)).toEqual({ status: 'acquired', recovered: true });
    await expect.poll(()=>running(old.pid),{timeout:6000}).toBe(false);
    expect(await invoke('release', f.profile, f.token, f.port)).toEqual({ status: 'released' });
  }, 20000);

  it('keeps a live owner and its Chrome intact, including when another token tries to release it', async () => {
    const f = await fixture(); expect((await invoke('acquire', f.profile, f.token, f.port)).status).toBe('acquired');
    const child = spawn(CHROME, [...flags(f.profile, f.port), '--headless=new', 'about:blank'], { stdio: 'ignore' });
    testBrowserPids.add(child.pid!);
    await ready(f.port);
    expect(await invoke('acquire', f.profile, randomUUID(), f.port)).toEqual({ error: 'CHROME_PROFILE_BUSY' });
    expect(await invoke('release', f.profile, randomUUID(), f.port)).toEqual({ error: 'CHROME_PROFILE_BUSY' });
    expect(running(child.pid!)).toBe(true);
    expect(await invoke('release', f.profile, f.token, f.port)).toEqual({ status: 'released' });
    expect(running(child.pid!)).toBe(false);
  }, 20000);

  it('does not mistake launchd-parented Chrome for an orphan while its background helper is alive', async () => {
    const f = await fixture();
    const child: ChildProcess = spawn(background, [...flags(f.profile, f.port), '--no-startup-window'], { stdio: ['ignore', 'pipe', 'ignore'] });
    cleanup.push(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 6000 }).toBe(true); });
    await ready(f.port);
    const pid = Number((await readlink(join(f.profile, 'SingletonLock'))).split('-').at(-1));
    testBrowserPids.add(pid);
    expect(await invoke('acquire', f.profile, f.token, f.port)).toEqual({ error: 'CHROME_PROFILE_BUSY' });
    expect(running(pid)).toBe(true); expect(child.exitCode).toBeNull();
  }, 20000);

  it('refuses a neighboring profile, mismatched debug port, or non-Chrome process without signaling it', async () => {
    const f = await fixture(), old = await orphan(f.profile, f.port, f.token);
    const neighbor = await fixture();
    await symlink(await readlink(join(f.profile, 'SingletonLock')), join(neighbor.profile, 'SingletonLock'));
    expect(await invoke('acquire', neighbor.profile, neighbor.token, neighbor.port)).toEqual({ error: 'CHROME_PROFILE_BUSY' });
    const path = join(f.profile, '.lifecycle-browser-owner.json'), lease = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...lease, port: f.port === 65535 ? 65534 : f.port + 1 }));
    expect(await invoke('acquire', f.profile, randomUUID(), f.port)).toEqual({ error: 'CHROME_PROFILE_BUSY' });
    expect(running(old.pid)).toBe(true);
    const nonChrome = await fixture();
    await symlink(`${execFileSync('/bin/hostname', { encoding: 'utf8' }).trim()}-${process.pid}`, join(nonChrome.profile, 'SingletonLock'));
    expect(await invoke('acquire', nonChrome.profile, nonChrome.token, nonChrome.port)).toEqual({ error: 'CHROME_PROFILE_BUSY' });
    expect(running(process.pid)).toBe(true);
  }, 20000);

  it('compares owner start time so a reused PID does not hide an abandoned browser', async () => {
    const f = await fixture(), old = await orphan(f.profile, f.port, f.token);
    const path = join(f.profile, '.lifecycle-browser-owner.json'), lease = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...lease, owner: { ...lease.owner, pid: process.pid, seconds: 1, microseconds: 0 } }));
    expect((await invoke('acquire', f.profile, randomUUID(), f.port)).recovered).toBe(true);
    await expect.poll(()=>running(old.pid),{timeout:6000}).toBe(false); expect(running(process.pid)).toBe(true);
  }, 20000);

  it('fails closed for invalid ownership metadata, foreign hosts, and profiles outside the app allowlist', async () => {
    const f = await fixture();
    await writeFile(join(f.profile, '.lifecycle-browser-owner.json'), 'invalid');
    expect(await invoke('acquire', f.profile, f.token, f.port)).toEqual({ error: 'CHROME_PROFILE_BUSY' });
    const other = await fixture();
    await symlink('another-host.local-12345', join(other.profile, 'SingletonLock'));
    expect(await invoke('acquire', other.profile, other.token, other.port)).toEqual({ error: 'CHROME_PROFILE_BUSY' });
    expect(await readlink(join(other.profile, 'SingletonLock'))).toBe('another-host.local-12345');
    const personal = join(other.dir, 'Personal Chrome'); await mkdir(personal);
    expect(await invoke('acquire', personal, randomUUID(), f.port)).toEqual({ error: 'CHROME_RECOVERY_UNAVAILABLE' });
    expect(existsSync(join(personal, '.lifecycle-recovery.lock'))).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BUNDLE_ID, BUNDLE_NAME } from '../electron/update-archive';
let root: string, helper: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'odoo-installer-fixture-'))); helper = join(root, 'installer');
  execFileSync('xcrun', ['swiftc', 'native/update-installer.swift', '-D', 'UPDATE_INSTALLER_TESTING', '-module-cache-path', resolve('dist-electron/swift-module-cache'), '-o', helper], { timeout: 60000 });
}, 65000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function bundle(path: string, version: string) {
  await mkdir(join(path, 'Contents/MacOS'), { recursive: true });
  await writeFile(join(path, 'Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: 'Odoo Lifecycle Manager', CFBundleShortVersionString: version }));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', join(path, 'Contents/Info.plist')]);
  await writeFile(join(path, 'Contents/MacOS/Odoo Lifecycle Manager'), 'fixture'); await chmod(join(path, 'Contents/MacOS/Odoo Lifecycle Manager'), 0o755);
  await writeFile(join(path, 'version'), version);
}
async function fixture(mode: 'install' | 'cancel' | 'rollback') {
  const directory = await mkdtemp(join(root, 'case-')), source = join(directory, 'new.app'), target = join(directory, BUNDLE_NAME), result = join(directory, 'result.json');
  await bundle(source, '1.9.0'); await bundle(target, '1.8.0');
  if (mode === 'rollback') await writeFile(join(source, 'fail-launch'), '');
  // A disposable parent process lets the real helper prove it waits for parent exit.
  const program = `const fs=require('node:fs'),{spawn}=require('node:child_process');
    const [helper,jobPath,jobJSON,mode]=process.argv.slice(1),job=JSON.parse(jobJSON);job.parentPID=process.pid;fs.writeFileSync(jobPath,JSON.stringify(job));
    const child=spawn(helper,[jobPath],{detached:true,stdio:['pipe','pipe','ignore']});let output='',ready=false;
    child.stdout.on('data',chunk=>{output+=chunk;if(!ready&&output.includes('READY\\n')){ready=true;
      if(fs.readFileSync(job.target+'/version','utf8')!=='1.8.0')process.exit(8);
      if(mode==='cancel'){child.stdin.end();child.on('exit',()=>process.exit(0));return;}
      child.stdin.end('INSTALL\\n');
      setTimeout(()=>{if(fs.readFileSync(job.target+'/version','utf8')!=='1.8.0')process.exit(9);process.exit(0);},250);
    }});child.on('exit',code=>{if(!output.includes('READY'))process.exit(10);});setTimeout(()=>process.exit(11),10000);`;
  const job = { source, target, result, currentVersion: '1.8.0', version: '1.9.0', parentPID: 0 };
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ['-e', program, helper, join(directory, 'job.json'), JSON.stringify(job), mode], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error(`Fixture parent exited ${code}`)));
  });
  await expect.poll(async () => { try { return JSON.parse(await readFile(result, 'utf8')).status; } catch { return null; } }, { timeout: 5000 }).toBe(mode === 'install' ? 'installed' : 'failed');
  return { target, directory };
}
describe('native unsigned installer in isolated temporary Applications fixtures', () => {
  it('waits for app exit, replaces atomically and keeps the old app backup', async () => {
    const f = await fixture('install'); expect(await readFile(join(f.target, 'version'), 'utf8')).toBe('1.9.0');
    expect(await readFile(join(f.directory, '.Odoo Lifecycle Manager.previous.app/version'), 'utf8')).toBe('1.8.0');
  });
  it('leaves the old app untouched if preparation is cancelled', async () => {
    const f = await fixture('cancel'); expect(await readFile(join(f.target, 'version'), 'utf8')).toBe('1.8.0');
  });
  it('rolls back to the old app if the new app cannot launch', async () => {
    const f = await fixture('rollback'); expect(await readFile(join(f.target, 'version'), 'utf8')).toBe('1.8.0');
  });
});

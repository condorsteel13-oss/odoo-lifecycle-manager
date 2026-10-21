import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs the real updater in Electron, whose fs behavior differs from Node for
// app.asar. This harness imports no account, browser, or lifecycle services.
test('Electron extracts app.asar, cleans failed staging, and completes the update handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'odoo-update-runtime-'));
  const runner = join(root, 'main.cjs'), archive = join(root, 'fixture.zip');
  execFileSync('python3', ['-c', `import plistlib,sys,zipfile
base='Odoo Lifecycle Manager.app/Contents/'
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for name,data,mode in [
  ('Info.plist',plistlib.dumps({'CFBundleIdentifier':'local.odoo.lifecycle-manager','CFBundleExecutable':'Odoo Lifecycle Manager','CFBundleShortVersionString':'1.9.0','LSMinimumSystemVersion':'13.0'}),0o100644),
  ('MacOS/Odoo Lifecycle Manager',b'fixture executable',0o100755),
  ('Resources/update-installer',b'fixture helper',0o100755),
  ('Resources/chrome-recovery',b'fixture Chrome recovery helper',0o100755),
  ('Resources/app.asar',b'physical ASAR payload',0o100644),
  ('Resources/app.asar.unpacked/native.node',b'physical unpacked payload',0o100644)]:
  i=zipfile.ZipInfo(base+name);i.create_system=3;i.external_attr=mode<<16;z.writestr(i,data)`, archive]);
  await build({ stdin: { contents: `
    import {app} from 'electron';
    import {AppUpdater,productionUpdateDownloads} from './electron/updater';
    import {updateDisk} from './electron/update-disk';
    app.setPath('userData',process.argv[2]);
    globalThis.updateRuntime={AppUpdater,productionUpdateDownloads,updateDisk};
  `, resolveDir: resolve('.'), sourcefile: 'update-runtime-main.ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: runner });
  const bytes = await readFile(archive);
  const desktop = await electron.launch({ args: [runner, join(root, 'user')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  try {
    const result = await desktop.evaluate(async (_electron, input) => {
      const { AppUpdater, productionUpdateDownloads, updateDisk } = (globalThis as any).updateRuntime;
      const { copyFile, readFile, lstat, readdir } = updateDisk.promises;
      const events: string[] = [], asarMode = process.noAsar;
      let failPreparation = true, busy = true, stageCalls = 0;
      const updater = new AppUpdater(input.root + '/updates', '1.8.0', true, () => {}, {
        latest: async () => ({ version: '1.9.0', size: input.size, sha256: input.digest, url: 'https://fixture.invalid/update.zip' }),
        download: async (_release: unknown, file: string) => { await copyFile(input.archive, file); },
        stage: async (...args: [string, string, string]) => {
          stageCalls++;
          const bundle = await productionUpdateDownloads.stage(...args);
          if (await readFile(bundle + '/Contents/Resources/app.asar', 'utf8') !== 'physical ASAR payload') throw Error('ASAR bytes changed');
          if (!(await lstat(bundle + '/Contents/Resources/app.asar')).isFile()) throw Error('ASAR was treated as a directory');
          if (await readFile(bundle + '/Contents/Resources/app.asar.unpacked/native.node', 'utf8') !== 'physical unpacked payload') throw Error('Unpacked content changed');
          return bundle;
        },
        prepare: async () => {
          if (failPreparation) throw Object.assign(new Error('private path must not leak'), { code: 'EACCES' });
          return { commit: async () => { events.push('commit'); }, cancel: () => { events.push('cancel'); } };
        },
        blockReason: () => busy ? 'A lifecycle is running' : null,
        acquire: () => { if (busy) throw Error('busy'); events.push('lock'); },
        release: () => { events.push('unlock'); },
        closeIdleConnections: async () => { events.push('close-idle'); },
        quit: () => { events.push('quit'); },
      });
      await updater.initialize();
      try {
        await updater.check();
        try { await updater.install(); } catch { /* A running lifecycle must block installation. */ }
        const blockedStageCalls = stageCalls;
        busy = false;
        let failure = '';
        try { await updater.install(); } catch (error) { failure = (error as Error).message; }
        const download = (await readdir(input.root + '/updates')).find((name: string) => name.startsWith('download-'));
        const failedStageWasRemoved = !(await readdir(input.root + '/updates/' + download)).some((name: string) => name.startsWith('stage-'));
        failPreparation = false;
        await updater.install();
        await updater.download(); // Removes the entire previous bundle, including app.asar.
        return { events, failure, blockedStageCalls, failedStageWasRemoved, status: updater.state().status, asarModeUnchanged: process.noAsar === asarMode };
      } finally { updater.dispose(); }
    }, { root, archive, size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') });
    expect(result.blockedStageCalls).toBe(0);
    expect(result.failure).toContain('starting the installer helper (EACCES)');
    expect(result.failure).not.toContain('private path');
    expect(result.failedStageWasRemoved).toBe(true);
    expect(result.events).toEqual(['lock', 'unlock', 'lock', 'close-idle', 'commit', 'quit']);
    expect(result.status).toBe('ready');
    expect(result.asarModeUnchanged).toBe(true);
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});

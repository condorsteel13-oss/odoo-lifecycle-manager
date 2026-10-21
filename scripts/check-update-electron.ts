// Offline release verification inside Electron. The isolated runner imports only
// update extraction code; it never loads Lifecycle Manager or any account data.
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const version: string = JSON.parse(await readFile('package.json', 'utf8')).version;
const archive = resolve(process.argv[2] ?? `release/Odoo-Lifecycle-Manager-${version}-universal.zip`);
const root = await mkdtemp(join(tmpdir(), 'odoo-update-electron-'));
const runner = join(root, 'main.cjs');
try {
  await build({ stdin: { contents: `
    import {app} from 'electron';
    import {join} from 'node:path';
    import {extractUpdate,validateBundle} from './electron/update-archive';
    import {updateDisk} from './electron/update-disk';
    const {mkdir,rm,lstat}=updateDisk.promises;
    (async()=>{
      const [archive,version,root]=process.argv.slice(2);
      app.setPath('userData',join(root,'isolated-user'));
      await app.whenReady();
      let code=0;
      try {
        const bundle=await extractUpdate(archive,join(root,'extracted'));
        await validateBundle(bundle,version);
        if(!(await lstat(join(bundle,'Contents/Resources/app.asar'))).isFile())throw Error('app.asar is not a physical file');
        await rm(join(root,'extracted'),{recursive:true,force:true});
        console.log('Electron '+process.versions.electron+': v'+version+' ZIP extraction, bundle validation and ASAR cleanup passed.');
      } catch(error){console.error(error);code=1;}
      finally{app.exit(code);}
    })();
  `, resolveDir: resolve('.'), sourcefile: 'update-release-check.ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: runner });
  const executable: string = createRequire(import.meta.url)('electron');
  const { stdout } = await promisify(execFile)(executable, [runner, archive, version, root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, timeout: 120000 });
  console.log(stdout.trim());
} finally { await rm(root, { recursive: true, force: true }); }

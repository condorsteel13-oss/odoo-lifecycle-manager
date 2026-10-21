import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archivePath, BUNDLE_NAME, extractUpdate } from '../electron/update-archive';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function archive(entries: { name: string; content: string; mode?: number }[]) {
  const directory = await mkdtemp(join(tmpdir(), 'odoo-archive-test-')); directories.push(directory);
  const file = join(directory, 'fixture.zip');
  execFileSync('python3', ['-c', `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for entry in json.loads(sys.argv[2]):
  i=zipfile.ZipInfo(entry['name']);i.create_system=3;i.external_attr=entry.get('mode',0o100644)<<16
  z.writestr(i,entry['content'])`, file, JSON.stringify(entries)], { stdio: 'pipe' });
  return { file, destination: join(directory, 'extract') };
}
it('preserves executable bits and internal framework symlinks', async () => {
  const root = `${BUNDLE_NAME}/Contents/Frameworks/F.framework`;
  const f = await archive([
    { name: `${root}/Versions/A/F`, content: 'binary', mode: 0o100755 },
    { name: `${root}/Versions/Current`, content: 'A', mode: 0o120777 },
    { name: `${root}/F`, content: 'Versions/Current/F', mode: 0o120777 },
  ]);
  await extractUpdate(f.file, f.destination);
  expect((await stat(join(f.destination, root, 'F'))).mode & 0o111).toBe(0o111);
  expect(await readFile(join(f.destination, root, 'F'), 'utf8')).toBe('binary');
  expect(await realpath(join(f.destination, root, 'F'))).toContain('/Versions/A/F');
});
it('rejects traversal, absolute names and entries outside the one app bundle', () => {
  for (const name of ['../outside', '/tmp/evil', 'Else.app/Contents/x', `${BUNDLE_NAME}/../../outside`, `${BUNDLE_NAME}/a\\b`, `${BUNDLE_NAME}/./a`, `${BUNDLE_NAME}/a\0b`]) expect(() => archivePath(name, '/tmp/fixture')).toThrow();
});
it('rejects symlinks escaping the bundle, device entries and case-insensitive collisions', async () => {
  for (const entries of [
    [{ name: `${BUNDLE_NAME}/outside`, content: '../../outside', mode: 0o120777 }],
    [{ name: `${BUNDLE_NAME}/device`, content: '', mode: 0o020666 }],
    [{ name: `${BUNDLE_NAME}/File`, content: 'a' }, { name: `${BUNDLE_NAME}/file`, content: 'b' }],
    [{ name: `${BUNDLE_NAME}/link`, content: '/tmp', mode: 0o120777 }, { name: `${BUNDLE_NAME}/link/outside`, content: 'evil' }],
  ]) { const f = await archive(entries); await expect(extractUpdate(f.file, f.destination)).rejects.toThrow(); }
});
it('cannot use an internal symlink to overwrite files in archive order', async () => {
  const f = await archive([
    { name: `${BUNDLE_NAME}/link`, content: 'target', mode: 0o120777 },
    { name: `${BUNDLE_NAME}/link/write`, content: 'evil' },
    { name: `${BUNDLE_NAME}/target/write`, content: 'original' },
  ]);
  await expect(extractUpdate(f.file, f.destination)).rejects.toThrow();
  expect(await readFile(join(f.destination, BUNDLE_NAME, 'target/write'), 'utf8')).toBe('original');
});

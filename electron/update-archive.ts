import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { updateDisk } from './update-disk';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateError } from './update-release';
const exec = promisify(execFile);
const { createWriteStream } = updateDisk;
const { mkdir, chmod, realpath, symlink, lstat } = updateDisk.promises;
export const BUNDLE_NAME = 'Odoo Lifecycle Manager.app';
export const BUNDLE_ID = 'local.odoo.lifecycle-manager';
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
export function archivePath(name: string, destination: string) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.') || !(name === BUNDLE_NAME + '/' || name.startsWith(BUNDLE_NAME + '/'))) throw updateError('The update archive contains an unsafe path.');
  const path = resolve(destination, name);
  if (!inside(join(destination, BUNDLE_NAME), path)) throw updateError('The update archive escapes the app bundle.');
  return path;
}
function openZip(file: string): Promise<ZipFile> { return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error) : resolve(zip))); }
function stream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> { return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error) : resolve(stream))); }
// All regular files are written before symlinks, so archive order cannot redirect writes.
export async function extractUpdate(file: string, destination: string) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  destination = await realpath(destination);
  const zip = await openZip(file), links: { path: string; target: string }[] = [], seen = new Set<string>();
  let entries = 0, expanded = 0;
  await new Promise<void>((resolveDone, reject) => {
    const fail = (error: unknown) => { zip.close(); reject(error); };
    zip.on('error', fail); zip.on('end', resolveDone);
    zip.on('entry', (entry: Entry) => { void (async () => {
      if (++entries > 40000 || (expanded += entry.uncompressedSize) > 2 * 1024 ** 3 || entry.generalPurposeBitFlag & 1) throw updateError('The update archive exceeds the supported limits.');
      const path = archivePath(entry.fileName, destination), key = path.normalize('NFD').toLowerCase();
      if (seen.has(key)) throw updateError('The update archive contains duplicate paths.');
      seen.add(key);
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff, type = mode & 0o170000;
      if (![0, 0o100000, 0o040000, 0o120000].includes(type)) throw updateError('The update archive contains an unsupported file type.');
      if (entry.fileName.endsWith('/')) { if (![0, 0o040000].includes(type)) throw updateError('The update archive has an invalid directory.'); await mkdir(path, { recursive: true, mode: 0o755 }); }
      else if (type === 0o120000) {
        if (entry.uncompressedSize > 4096) throw updateError('The update archive contains an invalid link.');
        const chunks: Buffer[] = []; for await (const chunk of await stream(zip, entry) as any) chunks.push(chunk);
        const target = Buffer.concat(chunks).toString('utf8');
        if (!target || target.startsWith('/') || target.includes('\0') || target.includes('\\') || !inside(join(destination, BUNDLE_NAME), resolve(dirname(path), target))) throw updateError('The update archive contains an unsafe link.');
        links.push({ path, target });
      } else {
        if (type === 0o040000) throw updateError('The update archive has an invalid file.');
        await mkdir(dirname(path), { recursive: true, mode: 0o755 });
        await pipeline(await stream(zip, entry), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
        await chmod(path, mode & 0o111 ? 0o755 : 0o644);
      }
      zip.readEntry();
    })().catch(fail); });
    zip.readEntry();
  });
  for (const link of links) { await mkdir(dirname(link.path), { recursive: true, mode: 0o755 }); await symlink(link.target, link.path); }
  const bundle = join(destination, BUNDLE_NAME);
  for (const link of links) if (!inside(bundle, await realpath(link.path))) throw updateError('The update archive has a link outside the app.');
  return bundle;
}
export async function validateBundle(bundle: string, version: string) {
  const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')]);
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== BUNDLE_ID || info.CFBundleShortVersionString !== version || info.CFBundleExecutable !== 'Odoo Lifecycle Manager') throw updateError('The downloaded app identity or version does not match this release.');
  for (const path of ['Contents/MacOS/Odoo Lifecycle Manager', 'Contents/Resources/update-installer']) {
    const absolute = join(bundle, path), stat = await lstat(absolute);
    if (!stat.isFile() || !(stat.mode & 0o111) || !inside(bundle, await realpath(absolute))) throw updateError('The downloaded app is incomplete.');
  }
  const { stdout: system } = await exec('/usr/bin/sw_vers', ['-productVersion']);
  const required = String(info.LSMinimumSystemVersion ?? '13.0').split('.').map(Number), actual = system.trim().split('.').map(Number);
  if (!required.every(Number.isFinite) || required.some((n, i) => n > (actual[i] ?? 0) && required.slice(0, i).every((p, j) => p === actual[j]))) throw updateError('This release needs a newer version of macOS.');
}

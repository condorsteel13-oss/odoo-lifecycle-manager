import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors';

export const REPOSITORY = 'condorsteel13-oss/odoo-lifecycle-manager';
export const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const MAX_DOWNLOAD = 600 * 1024 * 1024;
export interface UpdateRelease { version: string; url: string; size: number; sha256: string }
export const updateError = (message: string) => new AppError('UPDATE_FAILED', message);
export function compareVersions(a: string, b: string) {
  if (![a, b].every(v => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) && v.split('.').every(n => Number.isSafeInteger(Number(n))))) throw updateError('This version format is not supported by the updater.');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function parseRelease(value: unknown, currentVersion: string): UpdateRelease | null {
  const release = value as any;
  if (!release || release.draft !== false || release.prerelease !== false || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw updateError('GitHub did not return a stable release. Try again later.');
  const version = release.tag_name.slice(1);
  if (compareVersions(version, currentVersion) <= 0) return null;
  const name = `Odoo-Lifecycle-Manager-${version}-universal.zip`;
  const matches = Array.isArray(release.assets) ? release.assets.filter((a: any) => a.name === name) : [];
  if (matches.length !== 1) throw updateError('The new release does not have a complete universal Mac update yet. Try again later.');
  const asset = matches[0], url = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
  if (asset.state !== 'uploaded' || asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD) throw updateError('The release download could not be verified. The current app is unchanged.');
  return { version, url, size: asset.size, sha256: asset.digest.slice(7) };
}
export async function latestRelease(current: string, signal: AbortSignal, request: typeof fetch = fetch) {
  const response = await request(RELEASE_API, { redirect: 'error', signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Odoo-Lifecycle-Manager' } });
  if (!response.ok || !response.body) throw updateError('Unable to check GitHub for updates. Check your connection and try again later.');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 512 * 1024) throw updateError('The release response is too large.');
    chunks.push(chunk);
  }
  return parseRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')), current);
}
export function allowedAssetURL(url: string, initial: string) {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && !parsed.hash && (url === initial || ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname));
}
export async function verifyDownload(file: string, release: UpdateRelease) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; if (size > release.size) throw updateError('The update size did not match GitHub.'); hash.update(chunk); }
  if (size !== release.size || hash.digest('hex') !== release.sha256) throw updateError('The update checksum did not match GitHub. Download it again.');
}
export async function downloadRelease(release: UpdateRelease, file: string, signal: AbortSignal, progress: (percent: number) => void, request: typeof fetch = fetch) {
  let url = release.url, response: Response | undefined;
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (!allowedAssetURL(url, release.url)) throw updateError('GitHub redirected to an unsupported download host.');
    response = await request(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'Odoo-Lifecycle-Manager' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location || redirect === 5) throw updateError('The update download redirected too many times.');
    url = new URL(location, url).href;
  }
  if (response?.status !== 200 || !response.body) throw updateError('The update download failed. Try again later.');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let size = 0, lastReport = 0;
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > release.size) return callback(updateError('The update is larger than the published release.'));
    hash.update(chunk);
    if (Date.now() - lastReport > 250) { progress(Math.floor(size / release.size * 100)); lastReport = Date.now(); }
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    if (size !== release.size || hash.digest('hex') !== release.sha256) throw updateError('The update checksum did not match GitHub. The download was discarded.');
    progress(100);
  } catch (error) { await rm(file, { force: true }); throw error; }
}

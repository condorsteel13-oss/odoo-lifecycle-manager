// Offline package check: no app launch, provider session, or database requests.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractUpdate, validateBundle } from '../electron/update-archive';
import { parseRelease, REPOSITORY, verifyDownload } from '../electron/update-release';
const version: string = JSON.parse(await readFile('package.json', 'utf8')).version;
const name = `Odoo-Lifecycle-Manager-${version}-universal.zip`;
const file = resolve(process.argv[2] ?? `release/v${version}/${name}`);
const hash = createHash('sha256');
for await (const chunk of createReadStream(file)) hash.update(chunk);
const digest = hash.digest('hex');
const release = parseRelease({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name, state: 'uploaded', size: (await stat(file)).size, digest: `sha256:${digest}`, browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}` }] }, '0.0.0')!;
const directory = await mkdtemp(join(tmpdir(), 'odoo-update-package-'));
try {
  await verifyDownload(file, release);
  const bundle = await extractUpdate(file, join(directory, 'extracted'));
  await validateBundle(bundle, version);
  console.log(`v${version} update ZIP: size, SHA-256, archive paths, symlinks, bundle identity, executable permissions and macOS requirement verified.`);
  console.log(`SHA256 ${digest}`);
} finally { await rm(directory, { recursive: true, force: true }); }

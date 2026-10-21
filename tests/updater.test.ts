import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppUpdater, type UpdateDependencies } from '../electron/updater';
import { allowedAssetURL, compareVersions, downloadRelease, latestRelease, parseRelease, REPOSITORY, verifyDownload } from '../electron/update-release';

const body = Buffer.from('fixture archive'), digest = createHash('sha256').update(body).digest('hex');
function metadata() { return { tag_name: 'v1.9.0', draft: false, prerelease: false, assets: [{ name: 'Odoo-Lifecycle-Manager-1.9.0-universal.zip', state: 'uploaded', size: body.length, digest: `sha256:${digest}`, browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v1.9.0/Odoo-Lifecycle-Manager-1.9.0-universal.zip` }] }; }
const release = parseRelease(metadata(), '1.8.0')!;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const task of cleanup.splice(0)) await task(); });
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'odoo-update-test-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir; }

describe('release trust and downloads', () => {
  it('only accepts newer stable releases with the exact universal asset and GitHub digest', () => {
    expect(parseRelease(metadata(), '1.8.0')).toEqual(release);
    expect(parseRelease(metadata(), '1.9.0')).toBeNull(); expect(parseRelease(metadata(), '2.0.0')).toBeNull();
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    for (const version of ['1.9', '01.9.0', '1.9.0-beta', '9007199254740992.0.0']) expect(() => compareVersions(version, '1.8.0')).toThrow();
    for (const mutate of [
      (m: any) => m.draft = true, (m: any) => m.prerelease = true,
      (m: any) => m.assets[0].digest = null, (m: any) => m.assets[0].browser_download_url = 'https://evil.test/app.zip',
      (m: any) => m.assets[0].size = 0, (m: any) => m.assets[0].size = 1024 ** 3,
      (m: any) => m.assets.push(m.assets[0]), (m: any) => m.assets[0].name = 'intel.zip',
    ]) { const m = metadata(); mutate(m); expect(() => parseRelease(m, '1.8.0')).toThrow(); }
  });
  it('does not send authenticated requests or follow API redirects', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(metadata()));
    await expect(latestRelease('1.8.0', new AbortController().signal, request)).resolves.toEqual(release);
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/Authorization|Cookie/);
    await expect(latestRelease('1.8.0', new AbortController().signal, vi.fn(async () => new Response('rate limit', { status: 403 })))).rejects.toThrow(/Unable/);
  });
  it('limits redirect hosts and validates bytes before marking a download ready', async () => {
    const file = join(await temporary(), 'update.zip'), signal = new AbortController().signal, progress = vi.fn();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } })).mockResolvedValueOnce(new Response(body));
    await downloadRelease(release, file, signal, progress, request);
    expect(await readFile(file)).toEqual(body); expect(progress).toHaveBeenLastCalledWith(100); await verifyDownload(file, release);
    for (const url of ['http://release-assets.githubusercontent.com/f', 'https://evil.test/f', 'https://github.com/elsewhere/app', 'https://user@release-assets.githubusercontent.com/f', 'https://release-assets.githubusercontent.com:444/f']) expect(allowedAssetURL(url, release.url)).toBe(false);
    await rm(file);
    const malicious = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/f' } }));
    await expect(downloadRelease(release, file, signal, progress, malicious)).rejects.toThrow(/unsupported/); expect(malicious).toHaveBeenCalledTimes(1);
  });
  it('discards truncated, oversized and corrupt downloads; catches later cache tampering', async () => {
    const file = join(await temporary(), 'update.zip');
    for (const bytes of [body.subarray(1), Buffer.concat([body, body]), Buffer.alloc(body.length)]) {
      await expect(downloadRelease(release, file, new AbortController().signal, () => {}, vi.fn(async () => new Response(bytes)))).rejects.toThrow();
      await expect(readFile(file)).rejects.toThrow();
    }
    await writeFile(file, Buffer.alloc(body.length)); await expect(verifyDownload(file, release)).rejects.toThrow(/checksum/);
  });
});

async function fixture() {
  const root = await temporary(), installer = { commit: vi.fn(async () => {}), cancel: vi.fn() };
  let blocked: string | null = null, locked = false;
  const deps: UpdateDependencies = {
    latest: vi.fn(async () => release), download: vi.fn(async (_release, file, _signal, progress) => { await writeFile(file, body); progress(100); }),
    stage: vi.fn(async () => '/fixture/app'), prepare: vi.fn(async () => installer),
    blockReason: () => blocked,
    acquire: vi.fn(() => { if (blocked) throw new Error('busy'); locked = true; }),
    release: vi.fn(() => { locked = false; }), closeIdleConnections: vi.fn(async () => {}), quit: vi.fn(),
  };
  const updater = new AppUpdater(root, '1.8.0', true, () => {}, deps); await updater.initialize(); cleanup.unshift(async () => updater.dispose());
  return { updater, deps, installer, root, block: (reason: string | null) => { blocked = reason; }, locked: () => locked };
}
describe('updater lifecycle coordination', () => {
  it('downloads automatically while busy, never quits by itself, and installs only on request', async () => {
    const f = await fixture(); f.block('A lifecycle is running');
    await f.updater.check(); expect(f.updater.state().status).toBe('ready'); expect(f.deps.quit).not.toHaveBeenCalled();
    await expect(f.updater.install()).rejects.toThrow(/lifecycle/);
    expect(f.deps.stage).not.toHaveBeenCalled(); expect(f.deps.closeIdleConnections).not.toHaveBeenCalled(); expect(f.installer.commit).not.toHaveBeenCalled();
    f.block(null); await f.updater.install();
    expect(f.locked()).toBe(true); expect(f.installer.commit).toHaveBeenCalledTimes(1); expect(f.deps.quit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.deps.acquire).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.deps.closeIdleConnections).mock.invocationCallOrder[0]);
  });
  it('checks the lock again if a scheduled lifecycle starts during extraction', async () => {
    const f = await fixture(); await f.updater.check();
    vi.mocked(f.deps.stage).mockImplementation(async () => { f.block('scheduled cycle'); return '/fixture/app'; });
    await expect(f.updater.install()).rejects.toThrow();
    expect(f.deps.prepare).not.toHaveBeenCalled(); expect(f.deps.closeIdleConnections).not.toHaveBeenCalled(); expect(f.deps.quit).not.toHaveBeenCalled(); expect(f.locked()).toBe(false);
  });
  it('releases the lock and cancels the installer if idle connection cleanup fails', async () => {
    const f = await fixture(); await f.updater.check(); vi.mocked(f.deps.closeIdleConnections).mockRejectedValueOnce(new Error('fixture failure'));
    await expect(f.updater.install()).rejects.toThrow(/Local installation failed while closing idle browser sessions/);
    expect(f.installer.cancel).toHaveBeenCalledTimes(1); expect(f.installer.commit).not.toHaveBeenCalled(); expect(f.deps.quit).not.toHaveBeenCalled(); expect(f.locked()).toBe(false); expect(f.updater.state().status).toBe('ready');
  });
  it('does not quit if the helper fails, and allows retry without another download', async () => {
    const f = await fixture(); await f.updater.check(); vi.mocked(f.deps.prepare).mockRejectedValueOnce(new Error('fixture failure'));
    await expect(f.updater.install()).rejects.toThrow(); expect(f.locked()).toBe(false); expect(f.deps.quit).not.toHaveBeenCalled();
    await f.updater.install(); expect(f.installer.commit).toHaveBeenCalledTimes(1); expect(f.deps.download).toHaveBeenCalledTimes(1);
  });
  it('persists opt-out separately from database state and does not download when off', async () => {
    const f = await fixture(); await f.updater.setAutomatic(false); await f.updater.check();
    expect(f.updater.state().status).toBe('available'); expect(f.deps.download).not.toHaveBeenCalled();
    const restarted = new AppUpdater(f.root, '1.8.0', false, () => {}, f.deps); await restarted.initialize(); cleanup.unshift(async () => restarted.dispose());
    expect(restarted.state().automatic).toBe(false); await expect(restarted.check()).rejects.toThrow(/packaged/);
    await expect(f.updater.setAutomatic('yes')).rejects.toThrow(); await f.updater.download(); expect(f.updater.state().status).toBe('ready');
  });
  it('never quits when the installer fails to acknowledge the handoff', async () => {
    const f = await fixture(); await f.updater.check(); f.installer.commit.mockRejectedValueOnce(new Error('no acknowledgement'));
    await expect(f.updater.install()).rejects.toThrow(); expect(f.deps.quit).not.toHaveBeenCalled(); expect(f.installer.cancel).toHaveBeenCalledTimes(1); expect(f.locked()).toBe(false);
  });
});

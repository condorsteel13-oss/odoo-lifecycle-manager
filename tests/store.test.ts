import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../electron/store';
import { settingsSchema } from '../electron/schemas';
import { DEFAULT_SETTINGS, demoDiscovery } from '../src/domain/demo';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map(d => rm(d, { recursive: true, force: true }))); dirs.length = 0; });
describe('local storage and settings', () => {
  it('persists settings atomically and applies private permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'odoo-storage-test-')); dirs.push(dir);
    const store = new LocalStore(dir); const { data } = await store.load();
    await store.save({ ...data, settings: { ...data.settings, thresholdDays: 8 } });
    expect((await new LocalStore(dir).load()).data.settings.thresholdDays).toBe(8);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.path, 'utf8')).version).toBe(1);
  });
  it('preserves corrupt data and disables monitoring on recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'odoo-storage-test-')); dirs.push(dir);
    const store = new LocalStore(dir); await writeFile(store.path, '{ invalid');
    const result = await store.load();
    expect(result.recovered).toBe(true); expect(result.data.settings.monitoringEnabled).toBe(false);
    expect(result.data.liveSafetyLock).toBe(true);expect((await store.load()).data.liveSafetyLock).toBe(true);
    expect((await readdir(dir)).some(n => n.startsWith('state.corrupt-'))).toBe(true);
  });
  it('cannot activate live mode through settings', () => {
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, liveExecution: true }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, thresholdDays: -1 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, intervalHours: 1 }).success).toBe(false);
  });
  it('migrates old state with Safe mode on and automatic lifecycle disabled',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'odoo-storage-test-'));dirs.push(dir);const store=new LocalStore(dir);const {data}=await store.load();
    const old:any=structuredClone(data);delete old.workflowPreferences;delete old.lifecyclePreferences;delete old.lifecycleQueue;delete old.settings.lifecycleEnabled;delete old.settings.deleteAfterActivation;
    await writeFile(store.path,JSON.stringify(old));const loaded=await store.load();expect(loaded.recovered).toBe(false);expect(loaded.data.workflowPreferences).toEqual({activationEmailDelayMinutes:3,copyNameTemplate:'{name}-copy-{date}'});expect(loaded.data.lifecyclePreferences.safeMode).toBe(true);expect(loaded.data.settings.lifecycleEnabled).toBe(false);expect(loaded.data.settings.deleteAfterActivation).toBe(false);expect(loaded.data.lifecycleQueue).toEqual([]);
  });
  it('retains a closed cycle and its removal evidence across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'odoo-storage-test-')); dirs.push(dir);
    const store = new LocalStore(dir); const { data } = await store.load(); const original=demoDiscovery().databases[0], now=new Date().toISOString();
    const record={id:crypto.randomUUID(),createdAt:now,updatedAt:now,original,originalUuid:crypto.randomUUID(),copyName:'fixture-old-copy',phase:'copy-removed' as const,copy:original,copyUuid:crypto.randomUUID(),verifiedAt:null,backupReference:null,integrityNotes:null,message:'User-reported removal; account-list absence checked.',removal:{userReportedRemoved:true as const,checkedAt:now,previousPhase:'awaiting-expiry' as const}};
    await store.save({...data,liveHistory:[record]});
    const loaded=await new LocalStore(dir).load();expect(loaded.recovered).toBe(false);expect(loaded.data.liveHistory).toEqual([record]);
  });
});

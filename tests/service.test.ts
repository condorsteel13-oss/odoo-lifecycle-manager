import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppService, type ReadOnlyConnection } from '../electron/service';
import { LocalStore } from '../electron/store';
import { demoDiscovery } from '../src/domain/demo';
import { AppError } from '../electron/errors';
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'odoo-service-test-'));
  const sample = demoDiscovery();
  const real = { ...sample, source: 'odoo' as const, databases: sample.databases.map(d => ({ ...d, source: 'odoo' as const })) };
  const browser: ReadOnlyConnection = { connect: vi.fn().mockResolvedValue(real), refresh: vi.fn().mockResolvedValue(real), close: vi.fn().mockResolvedValue(undefined) };
  const service = new AppService(new LocalStore(join(dir, 'data')), join(dir, 'profile'), 'unused', () => {}, browser);
  await service.initialize();
  return { service, browser, real, cleanup: async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
describe('desktop service boundary', () => {
  it('manual simulation cannot invoke even a read-only browser operation', async () => {
    const { service, browser, cleanup } = await setup();
    try { const ids = await service.simulate(['demo-0', 'demo-1']); expect(ids).toHaveLength(2); expect(browser.connect).not.toHaveBeenCalled(); expect(browser.refresh).not.toHaveBeenCalled(); expect(browser.close).not.toHaveBeenCalled(); } finally { await cleanup(); }
  });
  it('switching to an account disables sample monitoring and clears scope', async () => {
    const { service, cleanup } = await setup();
    try {
      await service.saveSettings({ ...service.getState().settings, monitoringEnabled: true, scope: 'selected', databaseIds: ['demo-0'] });
      await service.connect();
      expect(service.getState().settings).toMatchObject({ monitoringEnabled: false, scope: 'all', databaseIds: [] });
      expect(service.getState().connection).toBe('connected');
    } finally { await cleanup(); }
  });
  it('failed refresh preserves metadata and never generates automatic reports from stale data', async () => {
    const { service, browser, cleanup } = await setup();
    try {
      await service.connect(); const original = service.getState().discovery;
      vi.mocked(browser.refresh).mockRejectedValue(new AppError('SESSION_EXPIRED', 'Reconnect to Odoo.'));
      await expect(service.runMonitor()).rejects.toThrow(/Reconnect/);
      expect(service.getState().history).toHaveLength(0);
      expect(service.getState().discovery).toEqual(original);
      expect(service.getState().connection).toBe('expired');
      expect(service.getState().lastAttemptAt).not.toBeNull();
    } finally { await cleanup(); }
  });
  it('serializes monitoring and deduplicates persisted automatic events', async () => {
    const { service, cleanup } = await setup();
    try {
      const pending = service.runMonitor();
      await expect(service.runMonitor()).rejects.toThrow(/current operation/);
      await pending;
      const count = service.getState().history.length;
      expect(count).toBe(3); await service.runMonitor(); expect(service.getState().history).toHaveLength(count);
    } finally { await cleanup(); }
  });
});

it('accepts the explicit Chrome handoff only during an active connection',async()=>{
 const {service,browser,real,cleanup}=await setup();
 try {
  let finish!:()=>void;
  vi.mocked(browser.connect).mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve(real);}));
  browser.finishLogin=vi.fn(()=>finish());
  await expect(service.finishLogin()).rejects.toThrow(/sign-in first/);
  const pending=service.connect();
  expect(service.getState()).toMatchObject({busy:true,connection:'connecting'});
  await service.finishLogin(); await pending;
  expect(browser.finishLogin).toHaveBeenCalledOnce();
  expect(service.getState()).toMatchObject({busy:false,connection:'connected'});
 } finally {await cleanup();}
});

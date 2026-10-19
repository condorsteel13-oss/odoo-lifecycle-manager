import { mkdir, readFile, writeFile, rename, chmod, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/domain/demo';
import { persistedSchema, type Persisted } from './schemas';
import { AppError } from './errors';
export class LocalStore {
  readonly path: string;
  constructor(readonly directory: string) { this.path = join(directory, 'state.json'); }
  async load(): Promise<{ data: Persisted; recovered: boolean }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const empty = (): Persisted => ({ version: 1, lifecycleQueue:[], lifecyclePreferences:{safeMode:true}, browserPreferences:{headless:true}, savedConnections:{odoo:false,mail:false}, settings: { ...DEFAULT_SETTINGS }, discovery: null, history: [], lastAttemptAt: null, liveHistory: [], liveSafetyLock: false });
    try {
      const raw = await readFile(this.path, 'utf8');
      try { return { data: persistedSchema.parse(JSON.parse(raw)), recovered: false }; }
      catch { await rename(this.path, join(this.directory, `state.corrupt-${Date.now()}.json`)); const data={...empty(),liveSafetyLock:true}; await this.save(data); return { data, recovered: true }; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: empty(), recovered: false };
      throw new AppError('STORAGE_READ', 'Local data could not be read. Check permissions for the app data directory.');
    }
  }
  async save(value: Persisted): Promise<void> {
    const valid = persistedSchema.parse(value);
    const temp = `${this.path}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(valid, null, 2), { mode: 0o600 });
      await chmod(temp, 0o600);
      const file = await open(temp, 'r'); try { await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw new AppError('STORAGE_WRITE', 'Local changes could not be saved. Check available disk space and app data permissions.'); }
  }
}

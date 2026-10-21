import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './errors';

export class ChromeProfileOwnership {
  private token = randomUUID();
  constructor(private profile: string, private port: number) {}
  private async invoke(action: 'acquire' | 'release') {
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const bundled = resources ? join(resources, 'chrome-recovery') : '';
    const helper = existsSync(bundled) ? bundled : join(process.cwd(), 'dist-electron/chrome-recovery');
    if (!existsSync(helper)) throw new AppError('CHROME_RECOVERY_UNAVAILABLE', 'The Chrome recovery helper is missing. Reinstall the app before reconnecting. Your saved sign-in is retained.');
    const result = await new Promise<{ error?: string; status?: string; recovered?: boolean }>((resolve, reject) => {
      execFile(helper, [action, this.profile, this.token, String(this.port)], { timeout: 10000, maxBuffer: 4096 }, (error, stdout) => {
        try {
          const result = JSON.parse(stdout);
          if (!result || typeof result !== 'object' || (!result.error && result.status !== (action === 'acquire' ? 'acquired' : 'released'))) throw Error();
          if (error && !result.error) throw Error();
          resolve(result);
        } catch { reject(new AppError('CHROME_RECOVERY_UNAVAILABLE', 'Chrome ownership could not be checked. Your saved sign-in is retained. Close the app’s previous Chrome window and reconnect.')); }
      });
    });
    if (result.error === 'CHROME_RECOVERY_UNAVAILABLE') throw new AppError(result.error, 'Chrome ownership could not be checked. Your saved sign-in is retained. Close the app’s previous Chrome window and reconnect.');
    if (result.error) throw new AppError(result.error === 'CHROME_CLOSE_TIMEOUT' ? result.error : 'CHROME_PROFILE_BUSY', result.error === 'CHROME_CLOSE_TIMEOUT'
      ? 'The app’s previous Chrome instance did not finish closing. Close that window and reconnect. Your saved sign-in is retained.'
      : 'The app’s Chrome profile is already in use or its owner could not be verified. Close its previous app/window and reconnect. Your personal Chrome and saved sign-in were left alone.');
    return result.recovered === true;
  }
  acquire() { return this.invoke('acquire'); }
  release() { return this.invoke('release'); }
}

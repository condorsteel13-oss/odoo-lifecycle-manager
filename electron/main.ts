import { app, BrowserWindow, dialog, ipcMain, session, safeStorage } from 'electron';
import { dirname, join } from 'node:path';
import { AppUpdater, installationLocation, prepareInstaller, productionUpdateDownloads } from './updater';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { AppService } from './service';
import { LocalStore } from './store';
import { exportReports } from '../src/domain/export';
import { idsSchema } from './schemas';
import { AppError, safeError } from './errors';
let window: BrowserWindow | null = null;
let service: AppService;
let quitting = false;
let updater: AppUpdater | undefined;
// Only used by local integration tests to isolate app data. This cannot change network policy.
const testDirectory = !app.isPackaged ? process.env.LIFECYCLE_TEST_DATA : undefined;
if (testDirectory) app.setPath('userData', testDirectory);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    const root = app.getPath('userData');
    const rendererFile = join(__dirname, '../dist/index.html');
    const dev = !app.isPackaged && process.argv.includes('--dev');
    const rendererURL = dev ? 'http://127.0.0.1:5173/' : pathToFileURL(rendererFile).href;
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    service = new AppService(new LocalStore(join(root, 'data')), join(root, 'chrome-profile'), app.isPackaged ? join(process.resourcesPath, 'browser-binaries') : join(app.getAppPath(), 'browser-binaries'), state => { if (window && !window.isDestroyed()) window.webContents.send('app:state-changed', state); updater?.emit(); }, undefined, async review => {
      if(!window || window.isDestroyed()) return false;
      const deleting=review.action==='delete';
      const choice=await dialog.showMessageBox(window,{type:'warning',title:deleting?'Permanently delete original database?':'Create a real testing copy?',message:deleting?`Permanently delete ${review.original.name}?`:`Duplicate ${review.original.name} as ${review.copyName}?`,detail:deleting?`Original: ${review.original.url}\nVerified copy to retain: ${review.copyName}\n\nAll original data will be removed for all users. A related subscription may be closed. Your backup and integrity confirmations are recorded. This cannot be undone. Only this original will be deleted.`:`Source: ${review.original.url}\nNew copy: https://${review.copyName}.odoo.com\n\nA real testing copy will be created with external actions neutralized. ${review.deleteOriginal===false?'Parent deletion is disabled for this cycle. Both databases will be retained.':'The original is retained until a separate deletion confirmation.'} ${review.workflow==='guided'?'The app will handle activation and verification after creation.':'Use Activate copy after completion.'} If Odoo reports a different activation recipient, the app sends the activation email to the signed-in database user. Mailbox sign-in is manual, and actual copy expiry must be verified after activation.`,buttons:['Cancel',deleting?'Permanently delete original':'Create testing copy'],defaultId:0,cancelId:0,noLink:true});
      return choice.response===1;
    }, {cipher:{available:()=>safeStorage.isEncryptionAvailable(),encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)},confirmAutomatic:async()=>{
      if(!window||window.isDestroyed())return false;
      const choice=await dialog.showMessageBox(window,{type:'warning',title:'Turn Safe mode off?',message:'Allow lifecycle steps without per-action confirmations?',detail:'Run lifecycle and enabled automatic lifecycle rules will create a testing copy, activate it using the connected mailbox, and verify it. Only when Delete original after successful activation is enabled will the original be permanently deleted. A related subscription may be closed by deletion. Backups and business-data review remain your responsibility; automatic mode does not claim to have performed them. Identity, activation, expiry, and accounting exclusions remain enforced. Turning this off does not start a cycle immediately, but enabled rules can run at the next scheduled check.',buttons:['Keep Safe mode on','Turn Safe mode off'],defaultId:0,cancelId:0,noLink:true});return choice.response===1;
    }});
    await service.initialize();
    const updateRoot = join(root, 'updates');
    const bundle = dirname(dirname(dirname(app.getPath('exe'))));
    const locationBlock = app.isPackaged && process.platform === 'darwin' ? await installationLocation(bundle, app.getPath('home')) : null;
    updater = new AppUpdater(updateRoot, app.getVersion(), app.isPackaged && process.platform === 'darwin', state => {
      if (window && !window.isDestroyed()) window.webContents.send('updates:changed', state);
    }, {
      ...productionUpdateDownloads,
      blockReason: () => service.updateBlockReason() ?? locationBlock,
      acquire: () => { if (locationBlock) throw new AppError('UPDATE_LOCATION', locationBlock); service.acquireUpdateLock(); },
      release: () => service.releaseUpdateLock(),
      closeIdleConnections: () => service.closeForUpdate(),
      prepare: (source, directory, version) => prepareInstaller({ helper: join(process.resourcesPath, 'update-installer'), bundle, currentVersion: app.getVersion(), root: updateRoot }, source, directory, version),
      quit: () => { updater?.dispose(); quitting = true; app.quit(); },
    });
    await updater.initialize();
    const commands: Record<string, (...args: any[]) => unknown> = {
      'updates:state': () => updater!.state(),
      'updates:check': () => updater!.check(),
      'updates:download': () => updater!.download(),
      'updates:install': () => updater!.install(),
      'updates:automatic': value => updater!.setAutomatic(value),
      'app:workflow-preferences':input=>service.saveWorkflowPreferences(input),
      'app:lifecycle-preferences':input=>service.saveLifecyclePreferences(input),
      'app:lifecycle-run':(id,name)=>service.runLifecycle(id,name),
      'app:lifecycle-continue':id=>service.continueLifecycle(id),
      'app:lifecycle-stop':()=>service.stopLifecycle(),
      'app:lifecycle-scheduled':id=>service.runScheduledLifecycle(id),
      'app:lifecycle-dismiss':id=>service.dismissScheduledLifecycle(id),
      'app:mail-connect':()=>service.connectMail(), 'app:mail-finish':()=>service.finishMailLogin(), 'app:mail-cancel':()=>service.cancelMailConnection(),
      'app:check-connections':()=>service.checkConnections(), 'app:browser-preferences':input=>service.saveBrowserPreferences(input),
      'app:state': () => service.getState(), 'app:connect': () => service.connect(), 'app:cancel': () => service.cancelConnection(), 'app:finish-login': () => service.finishLogin(),
      'app:refresh': () => service.refresh(), 'app:demo': () => service.useDemo(), 'app:disconnect': () => service.disconnect(),
      'app:clear-session': () => service.clearSession(), 'app:settings': settings => service.saveSettings(settings),
      'app:simulate': ids => service.simulate(ids), 'app:monitor': () => service.runMonitor(),
      'app:live-prepare-duplicate': (id,name) => service.prepareDuplicate(id,name),
      'app:live-prepare-delete': id => service.prepareDelete(id),
      'app:live-confirm': input => service.confirmLive(input),
      'app:live-cancel': () => service.cancelLive(),
      'app:live-verify': id => service.verifyCopy(id),
      'app:live-close-removed-copy': input => service.closeRemovedCopy(input),
      'app:live-retain-copy': id => service.retainCopy(id),
      'app:live-activate': id => service.activateCopy(id),
      'app:live-read-email': id => service.readActivationEmail(id),
      'app:export': async (ids?: unknown) => {
        const parsed = ids === undefined ? undefined : idsSchema.safeParse(ids);
        if (parsed && !parsed.success) throw new AppError('INVALID_EXPORT', 'Select valid reports to export.');
        const records = service.getState().history.filter(r => !parsed || (parsed.success && parsed.data.includes(r.id)));
        const choice = await dialog.showSaveDialog(window!, { title: 'Export simulation reports', defaultPath: `odoo-simulations-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON report', extensions: ['json'] }] });
        if (choice.canceled || !choice.filePath) return null;
        await writeFile(choice.filePath, JSON.stringify(exportReports(records), null, 2), { mode: 0o600 });
        return choice.filePath;
      },
    };
    for (const [channel, handler] of Object.entries(commands)) ipcMain.handle(channel, async (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererURL) throw new Error('Untrusted IPC sender.');
      try { if (channel.startsWith('app:') && channel !== 'app:state') service.assertNotUpdating(); return await handler(...args); } catch (error) { const safe = safeError(error); throw new Error(safe.message); } finally { updater?.emit(); }
    });
    const createWindow = () => {
      window = new BrowserWindow({ width: 1380, height: 940, minWidth: 1050, minHeight: 740, backgroundColor: '#f7f8fa', title: 'Odoo Lifecycle Manager', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 22, y: 22 }, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { if (url !== rendererURL) event.preventDefault(); });
      window.on('closed', () => { window = null; });
      void window.loadURL(rendererURL);
    };
    createWindow();
    if(service.getState().savedConnections.odoo||service.getState().savedConnections.mail)void service.restoreConnections().catch(()=>{});
    app.on('activate', () => { if (!window) createWindow(); });
  }).catch(() => { dialog.showErrorBox('Unable to start', 'The app could not initialize local storage. Check folder permissions and available disk space.'); app.quit(); });
  // Monitoring is explicitly tied to the running app; closing the last window exits.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !service) return;
    event.preventDefault();
    if (updater?.installing) return;
    quitting = true; updater?.dispose();
    void service.dispose().finally(() => app.quit());
  });
}

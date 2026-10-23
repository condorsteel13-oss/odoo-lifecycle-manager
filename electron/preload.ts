import { contextBridge, ipcRenderer } from 'electron';
import type { AppAPI, AppState } from '../src/shared/types';
const api: AppAPI = {
  saveLiveActionPreferences: input => ipcRenderer.invoke('app:live-action-preferences', input),
  saveWorkflowPreferences: input => ipcRenderer.invoke('app:workflow-preferences', input),
  saveLifecyclePreferences:input=>ipcRenderer.invoke('app:lifecycle-preferences',input),
  runLifecycle:(id,name)=>ipcRenderer.invoke('app:lifecycle-run',id,name),
  continueLifecycle:id=>ipcRenderer.invoke('app:lifecycle-continue',id),
  stopLifecycle:()=>ipcRenderer.invoke('app:lifecycle-stop'),
  runScheduledLifecycle:id=>ipcRenderer.invoke('app:lifecycle-scheduled',id),
  dismissScheduledLifecycle:id=>ipcRenderer.invoke('app:lifecycle-dismiss',id),
  connectMail:()=>ipcRenderer.invoke('app:mail-connect'),finishMailLogin:()=>ipcRenderer.invoke('app:mail-finish'),cancelMailConnection:()=>ipcRenderer.invoke('app:mail-cancel'),
  checkConnections:()=>ipcRenderer.invoke('app:check-connections'),saveBrowserPreferences:input=>ipcRenderer.invoke('app:browser-preferences',input),
  prepareDuplicate: (id,name) => ipcRenderer.invoke('app:live-prepare-duplicate',id,name),
  prepareDelete: id => ipcRenderer.invoke('app:live-prepare-delete',id),
  confirmLive: input => ipcRenderer.invoke('app:live-confirm',input),
  cancelLive: () => ipcRenderer.invoke('app:live-cancel'),
  verifyCopy: id => ipcRenderer.invoke('app:live-verify',id),
  closeRemovedCopy: input => ipcRenderer.invoke('app:live-close-removed-copy',input),
  retainCopy: id => ipcRenderer.invoke('app:live-retain-copy',id),
  activateCopy: id => ipcRenderer.invoke('app:live-activate',id),
  readActivationEmail: id => ipcRenderer.invoke('app:live-read-email',id),
  state: () => ipcRenderer.invoke('app:state'), connect: () => ipcRenderer.invoke('app:connect'),
  cancelConnection: () => ipcRenderer.invoke('app:cancel'), finishLogin: () => ipcRenderer.invoke('app:finish-login'), refresh: () => ipcRenderer.invoke('app:refresh'),
  useDemo: () => ipcRenderer.invoke('app:demo'), useOdoo: () => ipcRenderer.invoke('app:odoo-workspace'), disconnect: () => ipcRenderer.invoke('app:disconnect'), clearSession: () => ipcRenderer.invoke('app:clear-session'),
  simulate: ids => ipcRenderer.invoke('app:simulate', ids), saveSettings: settings => ipcRenderer.invoke('app:settings', settings),
  runMonitor: () => ipcRenderer.invoke('app:monitor'), exportHistory: ids => ipcRenderer.invoke('app:export', ids),
  exportLiveLog: range => ipcRenderer.invoke('app:export-live-log', range),
  subscribe: callback => { const listener = (_event: unknown, state: AppState) => callback(state); ipcRenderer.on('app:state-changed', listener); return () => ipcRenderer.removeListener('app:state-changed', listener); },
};
contextBridge.exposeInMainWorld('lifecycle', Object.freeze(api));

const updates: import('../src/shared/updates').UpdateAPI = {
  state: () => ipcRenderer.invoke('updates:state'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: () => ipcRenderer.invoke('updates:download'),
  install: () => ipcRenderer.invoke('updates:install'),
  setAutomatic: enabled => ipcRenderer.invoke('updates:automatic', enabled),
  subscribe: callback => { const listener = (_event: unknown, state: import('../src/shared/updates').UpdateState) => callback(state); ipcRenderer.on('updates:changed', listener); return () => ipcRenderer.removeListener('updates:changed', listener); },
};
contextBridge.exposeInMainWorld('updates', Object.freeze(updates));

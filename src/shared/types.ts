import type { LifecycleProgress } from './progress';
import type { WorkflowPreferences } from './workflow';
import type { LiveRecord, LiveReview, LiveConfirmation } from './live';
export const READ_ONLY_LABEL = 'Discovery and simulation are read-only. Safe mode confirms each live action.';
export type Availability = 'available' | 'unavailable' | 'unknown';
export type Source = 'demo' | 'odoo';
export interface Database {
  uuid?:string;
  id: string; name: string; url: string | null; version: string | null;
  createdAt: string | null; expiresAt: string | null;
  expirationEvidence: string | null;
  remainingDays?: number | null; expirationObservedAt?: string;
  status: 'active' | 'trial' | 'expired' | 'suspended' | 'unknown';
  designation: 'production' | 'testing' | 'unknown';
  subscription: 'linked' | 'none' | 'unknown';
  duplication: Availability; deletion: Availability;
  restrictions: string[]; observedAt: string; source: Source;
}
export interface Discovery {
  databases: Database[]; refreshedAt: string; source: Source;
  coverage: 'visible-list' | 'partial'; pages: number; warnings: string[];
}
export interface Settings {
  lifecycleEnabled:boolean;
  deleteAfterActivation:boolean;
  monitoringEnabled: boolean; thresholdDays: number; intervalHours: 6 | 12 | 24;
  scope: 'all' | 'selected'; databaseIds: string[];
}
export type StepStatus = 'passed' | 'requires-verification' | 'blocked' | 'simulated' | 'not-performed';
export interface SimulationStep { label: string; status: StepStatus; detail: string }
export interface Simulation {
  id: string; timestamp: string; databaseId: string; databaseName: string;
  source: Source; expirationDate: string | null; daysRemaining: number | null;
  proposedName: string; trigger: 'manual' | 'automatic'; eventKey: string;
  eligibility: 'requires-verification' | 'blocked'; steps: SimulationStep[];
  warnings: string[]; finalStatus: 'NO CHANGES MADE';
}
export interface Diagnostic { id: string; timestamp: string; code: string; message: string }
export interface ScheduledCycle {
  id:string; database:Database; copyName:string; detectedAt:string;
  status:'pending'|'running'|'complete'|'attention'|'dismissed'; recordId:string|null; message:string;
}
export type ConnectionStatus = 'demo' | 'disconnected' | 'connecting' | 'reading' | 'connected' | 'expired' | 'blocked';
export interface AppState {
  workflowPreferences: WorkflowPreferences;
  setupRequired:boolean;
  browserPreferences: { headless:boolean };
  lifecyclePreferences: { safeMode:boolean };
  lifecycleRun: { recordId:string|null; stage:string; stopping:boolean; active:boolean; progress?:LifecycleProgress } | null;
  lifecycleQueue:ScheduledCycle[];
  savedConnections: { odoo:boolean; mail:boolean };
  mailConnection: { status:ConnectionStatus; email:string|null; checkedAt:string|null };
  odooCheckedAt:string|null;
  liveHistory: LiveRecord[]; liveSafetyLock: boolean;
  settings: Settings; discovery: Discovery | null; history: Simulation[];
  connection: ConnectionStatus; busy: boolean; diagnostics: Diagnostic[];
  lastAttemptAt: string | null; nextCheckAt: string | null;
  dataDirectory: string; browserDirectory: string;
}
export interface AppAPI {
  saveWorkflowPreferences(input: WorkflowPreferences): Promise<void>;
  saveLifecyclePreferences(input:{safeMode:boolean}):Promise<void>;
  runLifecycle(databaseId:string,copyName:string):Promise<LiveReview|null>;
  continueLifecycle(recordId:string):Promise<LiveReview|null>;
  stopLifecycle():Promise<void>;
  runScheduledLifecycle(id:string):Promise<LiveReview|null>;
  dismissScheduledLifecycle(id:string):Promise<void>;
  connectMail():Promise<void>; finishMailLogin():Promise<void>; cancelMailConnection():Promise<void>;
  checkConnections():Promise<void>; saveBrowserPreferences(input:{headless:boolean}):Promise<void>;
  prepareDuplicate(databaseId: string, copyName: string): Promise<LiveReview>;
  prepareDelete(recordId: string): Promise<LiveReview>;
  confirmLive(input: LiveConfirmation): Promise<LiveReview|null>;
  cancelLive(): Promise<void>;
  verifyCopy(recordId: string): Promise<void>;
  closeRemovedCopy(input: {recordId: string; removedByUser: true}): Promise<void>;
  retainCopy(recordId: string): Promise<void>;
  activateCopy(recordId: string): Promise<void>;
  readActivationEmail(recordId: string): Promise<void>;
  state(): Promise<AppState>; connect(): Promise<void>; cancelConnection(): Promise<void>; finishLogin(): Promise<void>;
  refresh(): Promise<void>; useDemo(): Promise<void>; disconnect(): Promise<void>; clearSession(): Promise<void>;
  simulate(ids: string[]): Promise<string[]>; saveSettings(settings: Settings): Promise<void>;
  runMonitor(): Promise<void>; exportHistory(ids?: string[]): Promise<string | null>;
  subscribe(callback: (state: AppState) => void): () => void;
}
declare global { interface Window { lifecycle: AppAPI } }

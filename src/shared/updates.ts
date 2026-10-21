export interface UpdateState {
  currentVersion: string;
  latestVersion: string | null;
  automatic: boolean;
  supported: boolean;
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'preparing' | 'installing' | 'error';
  percent: number;
  checkedAt: string | null;
  message: string;
  installBlockReason: string | null;
}
export interface UpdateAPI {
  state(): Promise<UpdateState>;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  setAutomatic(enabled: boolean): Promise<void>;
  subscribe(callback: (state: UpdateState) => void): () => void;
}
declare global { interface Window { updates: UpdateAPI } }

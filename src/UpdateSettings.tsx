import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { UpdateState } from './shared/updates';

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let mounted = true, received = false;
    const unsubscribe = window.updates.subscribe(state => { received = true; if (mounted) setReady(state.status === 'ready'); });
    void window.updates.state().then(state => { if (mounted && !received) setReady(state.status === 'ready'); }).catch(() => {});
    return () => { mounted = false; unsubscribe(); };
  }, []);
  return ready ? <button className="update-notice" onClick={onOpen}><Download size={14}/>Update ready · View in Settings</button> : null;
}

export function UpdateSettings() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let mounted = true, received = false;
    const unsubscribe = window.updates.subscribe(value => { received = true; if (mounted) setState(value); });
    void window.updates.state().then(value => { if (mounted && !received) setState(value); }).catch(() => { if (mounted) setError('Could not load update settings.'); });
    return () => { mounted = false; unsubscribe(); };
  }, []);
  async function run(action: () => Promise<void>) {
    setPending(true); setError('');
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'The update could not finish.'); }
    finally { setPending(false); }
  }
  function changeAutomatic(enabled: boolean) {
    if (!state) return;
    const previous = state.automatic;
    setState({ ...state, automatic: enabled });
    void run(async () => {
      try { await window.updates.setAutomatic(enabled); }
      catch (error) { setState(current => current ? { ...current, automatic: previous } : current); throw error; }
    });
  }
  const working = pending || !!state && ['checking', 'downloading', 'preparing', 'installing'].includes(state.status);
  return <section className="panel settings-panel update-settings" aria-labelledby="update-title">
    <div className="eyebrow">APPLICATION</div><h2 id="update-title">App updates</h2>
    <p>Download new releases from GitHub automatically. You choose when to restart; a running lifecycle is never interrupted by an update.</p>
    {state && <>
      <div className="settings-row"><span>Installed version</span><strong>{state.currentVersion}</strong></div>
      <label className="update-option"><input type="checkbox" checked={state.automatic} disabled={working} onChange={event => changeAutomatic(event.target.checked)}/>Automatically check and download updates</label>
      <p className="small">Checks at startup and every 6 hours while the app is open. Installation requires the app to be in Applications.</p>
      <div className="update-status" role="status" aria-live="polite">{state.message}</div>
      {state.status === 'downloading' && <><progress aria-label="Update download" value={state.percent} max={100}/><span className="small">{state.percent}% downloaded</span></>}
      {state.status === 'ready' && state.installBlockReason && <p className="update-wait">{state.installBlockReason}</p>}
      <div className="button-row">
        <button className="button secondary" disabled={working || !state.supported || state.status === 'ready'} onClick={() => void run(() => window.updates.check())}><RefreshCw size={15}/>Check for updates</button>
        {['available', 'ready'].includes(state.status) && <button className="button secondary" disabled={working} onClick={() => void run(() => window.updates.download())}><Download size={15}/>{state.status === 'ready' ? 'Download again' : 'Download update'}</button>}
        {state.status === 'ready' && <button className="button primary" disabled={working || !!state.installBlockReason} onClick={() => void run(() => window.updates.install())}>Restart to install {state.latestVersion}</button>}
      </div>
      {state.checkedAt && <p className="small">Last checked: {new Date(state.checkedAt).toLocaleString()}</p>}
      <p className="small">This app is unsigned. macOS may ask you to approve opening it. Downloads are checked against GitHub’s SHA-256 digest; settings and saved sessions are kept.</p>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

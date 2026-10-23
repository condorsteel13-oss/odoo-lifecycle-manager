import { useState } from 'react';
import { Check, Clock3, Database as DatabaseIcon, Play, ShieldCheck } from 'lucide-react';
import type { AppState, Settings } from './shared/types';
import { daysRemaining } from './domain/dates';
import { matchesLifecycleRule } from './domain/lifecycle-schedule';
import { matchesRule } from './domain/monitor';

type Mode = 'off' | 'monitor' | 'lifecycle';
function mode(settings: Settings): Mode {
  return settings.lifecycleEnabled ? 'lifecycle' : settings.monitoringEnabled ? 'monitor' : 'off';
}
const modeTitles = { off: 'Automation is off', monitor: 'Monitor only is on', lifecycle: 'Automatic lifecycle is on' };
function timestamp(value: string | null) {
  return value ? new Date(value).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not yet';
}
function outcome(settings: Settings, safeMode: boolean) {
  if (mode(settings) === 'off') return 'No scheduled checks or database changes.';
  if (mode(settings) === 'monitor') return 'Refresh expiry information and save simulations. No database changes.';
  return `Duplicate → Activate → Verify → ${settings.deleteAfterActivation ? 'Delete original' : 'Keep original'}. ${safeMode ? 'Ask before each live step.' : 'Run without confirmation prompts.'}`;
}

export function Automation({ state, now, run }: {
  state: AppState;
  now: Date;
  run: (action: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Settings>(() => ({ ...state.settings, databaseIds: [...state.settings.databaseIds] }));
  const draftMode = mode(draft), savedMode = mode(state.settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  const safeMode = state.lifecyclePreferences.safeMode;
  const matches = (state.discovery?.databases ?? []).filter(db => draft.lifecycleEnabled ? matchesLifecycleRule(db, draft, now) : matchesRule(db, draft, now));
  const invalidScope = draftMode !== 'off' && draft.scope === 'selected' && !draft.databaseIds.length;
  function changeMode(value: Mode) {
    setDraft(previous => ({ ...previous, monitoringEnabled: value === 'monitor', lifecycleEnabled: value === 'lifecycle' }));
  }

  return <div className="automation-page">
    <section className={`automation-status ${savedMode === 'lifecycle' ? 'live' : ''}`} aria-label="Saved automation status">
      <div><span className="eyebrow">CURRENTLY SAVED</span><h2>{modeTitles[savedMode]}</h2><p>{outcome(state.settings, safeMode)}</p></div>
      <div className="automation-schedule"><Clock3 size={17}/><div>{savedMode === 'off' ? <strong>No scheduled checks</strong> : <><strong>Next check: {state.nextCheckAt ? timestamp(state.nextCheckAt) : 'Within one minute'}</strong><span>Every {state.settings.intervalHours} hours · while the app is open and Mac awake</span></>}<span>Last check started: {timestamp(state.lastAttemptAt)}</span></div></div>
    </section>
    <div className="automation-layout">
      <section className="panel automation-form" aria-labelledby="automation-rule-title">
        <div className="panel-heading"><div><h2 id="automation-rule-title">Set up automation</h2><p>Changes take effect when you save.</p></div></div>
        <div className="form-body">
          <label className="form-label">1. What should the app do?
            <select aria-label="Automation mode" value={draftMode} disabled={state.busy} onChange={e => changeMode(e.target.value as Mode)}>
              <option value="off">Off — no scheduled actions</option>
              <option value="monitor">Monitor only — no database changes</option>
              <option value="lifecycle">Run lifecycle — duplicate and activate</option>
            </select>
          </label>
          <p className="automation-help">{draftMode === 'off' ? 'Stops future scheduled checks and lifecycle runs. An active run must be stopped separately.' : draftMode === 'monitor' ? 'Check expiry and save a simulation report. Databases stay unchanged.' : 'Create a copy, activate it by email, then verify its identity and expiry.'}</p>

          <fieldset className="automation-timing" disabled={state.busy}>
            <legend>2. When and which databases?</legend>
            <label className="form-label">Act when expiry is within
              <div className="number-field"><input type="number" min="0" max="365" aria-label="Expiration threshold" value={draft.thresholdDays} onChange={e => setDraft({ ...draft, thresholdDays: Number(e.target.value) })}/><span>days (including today)</span></div>
            </label>
            <label className="form-label">Check interval<select value={draft.intervalHours} onChange={e => setDraft({ ...draft, intervalHours: Number(e.target.value) as Settings['intervalHours'] })}><option value={6}>Every 6 hours</option><option value={12}>Every 12 hours</option><option value={24}>Every 24 hours</option></select></label>
            <label className="form-label">Database scope<select value={draft.scope} onChange={e => setDraft({ ...draft, scope: e.target.value as Settings['scope'] })}><option value="all">All discovered databases</option><option value="selected">Specific databases</option></select></label>
            {draft.scope === 'selected' && <div className="scope-list">{state.discovery?.databases.map(db => <label key={db.id}><input type="checkbox" checked={draft.databaseIds.includes(db.id)} onChange={e => setDraft({ ...draft, databaseIds: e.target.checked ? [...draft.databaseIds, db.id] : draft.databaseIds.filter(id => id !== db.id) })}/>{db.name}</label>)}</div>}
          </fieldset>
          {invalidScope && <p className="automation-validation" role="alert">Select at least one database.</p>}

          <div className="automation-deletion">
            <h3>3. Keep or delete the original?</h3>
            <label className="live-check"><input type="checkbox" aria-label="Delete original after successful activation" checked={draft.deleteAfterActivation} disabled={state.busy} onChange={e => setDraft({ ...draft, deleteAfterActivation: e.target.checked })}/>Delete original after successful activation</label>
            <p className="automation-help">{draft.deleteAfterActivation ? 'Permanently delete the original only after the copy passes verification.' : 'Keep both databases. Use this to test without deletion.'} This choice also applies to runs started in Live actions.</p>
          </div>
          <div className="automation-confirmations"><ShieldCheck size={18}/><div><strong>Safe mode {safeMode ? 'on — asks before each live step' : 'off — no confirmation prompts'}</strong><p>Change Safe mode in Settings. Monitor only never changes databases.</p></div></div>
          <div className="automation-save">
            {dirty && <p role="status">Unsaved changes. The saved automation above is still in effect.</p>}
            {dirty && draftMode !== 'off' && <p>Saving enables this rule; the first check can start within one minute.</p>}
            <button className="button primary full" disabled={state.busy || !dirty || invalidScope} onClick={() => run(() => window.lifecycle.saveSettings(draft), 'Automation settings saved.')}><Check size={16}/>Save automation</button>
          </div>
        </div>
      </section>

      <div>
        <section className="panel preview-panel" aria-label="Automation preview">
          <div className="panel-heading"><div><div className="eyebrow">{dirty ? 'AFTER SAVING' : 'SAVED RULE'}</div><h2>{draftMode === 'off' ? 'No automatic actions' : `${matches.length} matching database${matches.length === 1 ? '' : 's'}`}</h2></div><span className="badge purple">{dirty ? 'Not saved' : 'Saved'}</span></div>
          <div className="automation-outcome"><strong>What will happen</strong><p>{outcome(draft, safeMode)}</p>{draftMode !== 'off' && <p>When {draft.scope === 'all' ? 'any discovered database has' : 'a selected database has'} 0–{draft.thresholdDays} days left, checked every {draft.intervalHours} hours.</p>}</div>
          {draftMode !== 'off' && <div className="preview-list">{matches.length ? matches.map(db => <div key={db.id}><div className="db-icon"><DatabaseIcon size={16}/></div><div><strong>{db.name}</strong><span>Within the expiry threshold</span></div><span className="badge warning">{daysRemaining(db.expiresAt, now) ?? db.remainingDays}d left</span></div>) : <div className="automation-empty"><Clock3 size={24}/><h3>No current matches</h3><p>Based on the last database refresh. A new check reads expiry information again.</p></div>}</div>}
          <div className="preview-footer">
            <p>{dirty ? 'Save your changes before running a check.' : savedMode === 'lifecycle' ? 'This starts the saved lifecycle rule now. The deletion and Safe mode settings above apply.' : 'You can run a read-only check now, even when automation is off.'}</p>
            <button className="button secondary full" disabled={state.busy || dirty} onClick={() => run(() => window.lifecycle.runMonitor(), 'Check completed. See simulation history and the lifecycle queue for results.')}><Play size={14}/>{savedMode === 'lifecycle' ? 'Run lifecycle now' : 'Check now (read-only)'}</button>
          </div>
        </section>
        <details className="automation-details"><summary>How it works</summary><p>Keep the app open and the Mac awake. Closing or sleeping pauses checks; missed checks are not replayed.</p><p>Unknown expiry and expired or suspended databases are skipped. Lifecycle rules also require a fresh reading and verified database identity. Monitor only requires an expiry date.</p><p>Matches are a preview, not a guaranteed job list. Previously handled expiry events are skipped to avoid repeated copies. A copy needs a later expiry before another automatic cycle. Odoo decides the copy’s expiry.</p><p>With Safe mode on, review queued databases in Live actions. Interrupted runs need explicit continuation. Turning automation off does not stop an active run or remove queued jobs.</p><p>Selected rules follow the verified copy after deleting its original. Continuing an unfinished run uses the current deletion choice; completed runs stay closed.</p></details>
      </div>
    </div>
  </div>;
}

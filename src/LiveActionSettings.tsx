import type { AppState } from './shared/types';
import { useState } from 'react';

export function LiveActionSettings({state,run}:{state:AppState;run:(action:()=>Promise<void>)=>Promise<void>}) {
  const deleting=state.settings.deleteAfterActivation;
  const [pending,setPending]=useState<boolean|null>(null);
  async function change(deleteOriginal:boolean) {
    setPending(deleteOriginal);
    try { await run(()=>window.lifecycle.saveLiveActionPreferences({deleteOriginal})); }
    finally { setPending(null); }
  }
  return <section className="panel settings-panel" aria-label="Live action settings">
    <h2>Live actions</h2>
    <label className="live-check"><input type="checkbox" checked={pending??deleting} disabled={state.busy||pending!==null} onChange={event=>void change(event.target.checked)}/>Delete original database after successful activation</label>
    <p>{deleting?'On: Run lifecycle deletes the original after the copy is activated and verified.':'Off: Run lifecycle keeps both the original and the activated copy.'} {state.lifecyclePreferences.safeMode?'Safe mode asks before duplication, sending activation email, activation and, when enabled, deletion.':'Safe mode is off: the cycle follows this setting without per-step prompts.'}</p>
    <p className="small">This is the same deletion setting used by Automation. Saving it starts no actions. Deletion requires a verified copy identity, completed activation and positive expiry. Continuing an unfinished cycle uses the current setting. Completed cycles stay closed.</p>
  </section>;
}

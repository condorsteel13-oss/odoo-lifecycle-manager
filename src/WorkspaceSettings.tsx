import type { AppState } from './shared/types';
import { useState } from 'react';

type Props = { state: AppState; run: (action: () => Promise<unknown>, success?: string) => Promise<void> };

export function WorkspaceSwitch({ state, run }: Props) {
  const actual = state.discovery?.source === 'odoo';
  const [pending, setPending] = useState(false);
  async function toggle() {
    setPending(true);
    try {
      await run(() => actual ? window.lifecycle.useDemo() : window.lifecycle.useOdoo(), actual ? 'Sample workspace selected. Automation is off.' : 'Odoo workspace selected. Automation is off.');
    } finally { setPending(false); }
  }
  return <div className="sidebar-workspace-switch">
    <div className="workspace-switch-row"><span className={!actual ? 'selected' : ''} aria-hidden="true">Sample</span>
      <button role="switch" aria-label="Use my Odoo workspace" aria-describedby="workspace-switch-hint" aria-checked={actual} disabled={state.busy || pending} className={`toggle ${actual ? 'on' : ''}`} onClick={() => void toggle()}><span/></button>
      <span className={actual ? 'selected' : ''} aria-hidden="true">Odoo</span></div>
    <p id="workspace-switch-hint">{pending ? 'Switching workspace…' : 'Switching pauses automation'}</p>
  </div>;
}

export function WorkspaceSettings({ state }: { state: AppState }) {
  const actual = state.discovery?.source === 'odoo';
  return <section className="panel settings-panel workspace-settings" aria-labelledby="workspace-settings-title">
    <h2 id="workspace-settings-title">Workspace</h2>
    <p>Choose your real Odoo databases or sample data.</p>
    <div className="settings-row"><strong>{actual ? 'Odoo workspace' : 'Sample workspace'}</strong></div>
    <p>Use the Sample / Odoo switch above the Lifecycle logo to change workspace from any screen.</p>
    <p>Switching pauses automation and reuses your saved Odoo sign-in where possible. If it has expired, reconnect in Connection. Viamail and the live action log are kept.</p>
    <p>After switching, review your rule in Automation and save it to enable scheduled runs again.</p>
  </section>;
}

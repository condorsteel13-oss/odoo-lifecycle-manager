import type { AppState } from './shared/types';

export function WorkspaceSettings({ state, run }: { state: AppState; run: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const actual = state.discovery?.source === 'odoo';
  return <section className="panel settings-panel workspace-settings" aria-labelledby="workspace-settings-title">
    <h2 id="workspace-settings-title">Workspace</h2>
    <p>Choose your real Odoo databases or sample data.</p>
    <div className="settings-row"><div><strong>Use my Odoo workspace</strong><p>{actual ? 'Your Odoo databases are selected.' : 'Sample workspace is selected.'}</p></div><button role="switch" aria-label="Use my Odoo workspace" aria-checked={actual} disabled={state.busy} className={`toggle ${actual ? 'on' : ''}`} onClick={() => run(() => actual ? window.lifecycle.useDemo() : window.lifecycle.useOdoo(), actual ? 'Sample workspace selected. Automation is off.' : 'Odoo workspace selected. Automation is off.')}><span/></button></div>
    <p>Switching pauses automation and reuses your saved Odoo sign-in where possible. If it has expired, reconnect in Connection. Viamail and the live action log are kept.</p>
    <p>After switching, review your rule in Automation and save it to enable scheduled runs again.</p>
  </section>;
}

export function AppGuide() {
  return <section className="panel settings-panel app-guide" aria-labelledby="app-guide-title">
    <div className="eyebrow">QUICK START &amp; WORKSPACE GUIDE</div>
    <h2 id="app-guide-title">How to use Lifecycle Manager</h2>
    <p>See when your Odoo databases expire, try a simulation, or create and activate a real testing copy. You choose whether to keep the original.</p>

    <ol className="guide-start">
      <li><strong>Connect your accounts</strong><p>In Connection, sign into Odoo and Viamail. Check that both show Connected.</p></li>
      <li><strong>Check your databases</strong><p>In Databases, click Refresh list to read expiry dates or days remaining from each Manage page.</p></li>
      <li><strong>Choose how to run</strong><p>Use Live actions for one database now, or Automation for an expiry-based rule.</p></li>
    </ol>

    <div className="guide-controls">
      <h3>Two separate controls</h3>
      <p><strong>Safe mode</strong> in Settings asks before creation and, when enabled, before deletion. Turning Safe mode off removes those prompts; it does not start a cycle by itself. Enabled rules can run at the next check.</p>
      <p><strong>Delete original after successful activation</strong> in Automation decides whether a lifecycle deletes the parent. Leave it off to test: both databases are kept, even with Safe mode off. Turning it on later does not change a cycle that started with deletion off.</p>
    </div>

    <h3 className="guide-sections-title">What each workspace section does</h3>
    <div className="guide-sections">
      <details>
        <summary>Databases <span>View expiry and try a simulation</span></summary>
        <p>Search your databases, filter expiring ones, and open Details to see when expiry was last read. Unknown means the app could not verify it.</p>
        <p><strong>Simulate</strong> previews a duplicate-and-delete plan and saves a report. It does not create, activate, or delete anything.</p>
      </details>
      <details>
        <summary>Connection <span>Sign in and check connection status</span></summary>
        <p>Sign in manually in Chrome. After Odoo login, click <strong>Read databases</strong>; after Viamail login, click <strong>Verify Viamail login</strong>. Use the mailbox matching the signed-in Odoo user.</p>
        <p>Saved sessions are reused on this Mac. Reconnect if sign-in expires. Background mode hides Chrome during work; sign-in always opens a visible window.</p>
      </details>
      <details>
        <summary>Automation <span>Run when databases approach expiry</span></summary>
        <p>Choose a threshold, check interval, and all or selected databases. For example, a threshold of 3 matches databases with 0–3 days remaining.</p>
        <p><strong>Automatic monitoring</strong> refreshes and simulates only. <strong>Run lifecycle automatically</strong> enables real cycles. Choose the deletion setting, then click <strong>Save monitoring rule</strong>.</p>
        <p><strong>Run lifecycle rule now</strong> checks the saved rule immediately. With Safe mode on, matching databases wait in the Live actions queue for review. Keep the app open and the Mac awake for scheduled checks. Accounting is excluded.</p>
      </details>
      <details>
        <summary>Simulation history <span>Review plans without making changes</span></summary>
        <p>Open past simulation reports to see the proposed copy name, checks, and any blockers. <strong>Export JSON</strong> saves reports to a file. These reports are plans, not proof that a real action happened.</p>
      </details>
      <details>
        <summary>Live actions <span>Create, activate, and track real copies</span></summary>
        <p>Choose an original, review the proposed copy name, and click <strong>Run lifecycle</strong>. Or open <strong>Review scheduled lifecycle</strong> for a queued rule. With Safe mode on, type the original name, tick the authorization, and confirm creation.</p>
        <p>The app creates the copy, sends activation to the signed-in Odoo user if needed, waits for the configured email delay, reads that copy’s email, activates it, and verifies its expiry. It then keeps both databases or proceeds to deletion, according to the deletion setting.</p>
        <p>The progress bar shows completed stages, not time remaining. Expand <strong>Step history</strong> for messages. If a step fails or needs attention, read the message before continuing. <strong>Stop lifecycle</strong> stops later steps; it cannot undo a request already sent.</p>
        <p><strong>Review duplication</strong> creates a copy only; activation is a separate step. Odoo determines the actual expiry, so a copy is not guaranteed extra days.</p>
      </details>
      <details>
        <summary>Settings <span>Choose defaults and find help</span></summary>
        <p>Set the activation email delay (default: 3 minutes) and copy name template, then click <strong>Save duplication settings</strong>. Use <code>{'{name}-copy'}</code> or <code>{'{name}-copy-{date}'}</code>; the app adds a number if the name is already used.</p>
        <p>The email delay starts when the copy is available, or after a resend if one is needed. Each new cycle keeps its saved delay. Queued copy names stay unchanged.</p>
        <p>Also choose Safe mode and browser visibility here. Closing browsers keeps saved sessions; clearing sessions requires signing in again. Reports and the live action log stay on this Mac. Diagnostics explain connection or workflow problems.</p>
      </details>
    </div>
  </section>;
}

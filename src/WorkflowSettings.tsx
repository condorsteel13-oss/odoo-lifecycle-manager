import { useState } from 'react';
import type { AppState } from './shared/types';
import { copyNameTemplateError, proposeName } from './domain/copy-name';

export function WorkflowSettings({state, run}: {state:AppState; run:(action:()=>Promise<unknown>, success?:string)=>Promise<void>}) {
  const saved=state.workflowPreferences;
  const [minutes,setMinutes]=useState(String(saved.activationEmailDelayMinutes));
  const [template,setTemplate]=useState(saved.copyNameTemplate);
  const delay=Number(minutes);
  const delayError=minutes.trim()===''||!Number.isInteger(delay)||delay<0||delay>60;
  const nameError=copyNameTemplateError(template);
  const dirty=delay!==saved.activationEmailDelayMinutes||template!==saved.copyNameTemplate;
  const preview=nameError?null:proposeName('example-db',['example-db'],new Date(),template);
  return <section className="panel settings-panel workflow-settings">
    <h2>Duplication &amp; activation</h2>
    <label className="form-label">Activation email delay (minutes)
      <input type="number" min="0" max="60" step="1" value={minutes} disabled={state.busy} aria-invalid={delayError} aria-describedby="email-delay-help" onChange={e=>setMinutes(e.target.value)}/>
    </label>
    <p id="email-delay-help">Wait after the new copy becomes available before checking Viamail. If Odoo resends the email to your signed-in address, wait from that send instead. Default: 3 minutes. Use 0 to check immediately.</p>
    {delayError?<p role="alert">Enter a whole number from 0 to 60 minutes.</p>:null}
    <label className="form-label">Copy name template
      <input type="text" value={template} maxLength={100} spellCheck={false} autoCapitalize="none" disabled={state.busy} aria-invalid={Boolean(nameError)} aria-describedby="copy-template-help" onChange={e=>setTemplate(e.target.value)}/>
    </label>
    <p id="copy-template-help">Use <code>{'{name}'}</code> for the original name and optional <code>{'{date}'}</code> for the UTC date (YYYYMMDD). Examples: <code>{'{name}-copy'}</code> or <code>{'{name}-copy-{date}'}</code>.</p>
    {nameError?<p role="alert">{nameError}</p>:<p className="name-preview">Example: <strong>{preview}</strong></p>}
    <p className="small">Names are shortened to fit 50 characters. Conflicts receive -2, -3, and so on. You can edit the proposed name in Live actions. New names use this template; queued names stay unchanged. Each copy keeps the delay saved when its creation starts.</p>
    <button className="button primary" disabled={state.busy||!dirty||delayError||Boolean(nameError)} onClick={()=>run(()=>window.lifecycle.saveWorkflowPreferences({activationEmailDelayMinutes:delay,copyNameTemplate:template}),'Duplication and activation settings saved.')}>Save duplication settings</button>
  </section>;
}

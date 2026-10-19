// Pure local planning. No browser, Electron, network, filesystem, or execution adapters.
import type { Database, Discovery, Simulation, SimulationStep } from '../shared/types';
import { daysRemaining } from './dates';
import { eventKey } from './monitor';
export function proposeName(name: string, existing: string[], now: Date): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'database';
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const base = `${stem}-copy-${date}`;
  const used = new Set(existing.map(n => n.toLowerCase()));
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix++) {
    const tail = `-copy-${date}-${suffix}`;
    candidate = `${stem.slice(0,50-tail.length).replace(/-$/, '')}${tail}`;
  }
  return candidate;
}
export function simulate(db: Database, discovery: Discovery, trigger: 'manual' | 'automatic', authenticated: boolean, now = new Date(), reserved: string[] = []): Simulation {
  const days = daysRemaining(db.expiresAt, now) ?? db.remainingDays ?? null;
  const unavailable = db.duplication === 'unavailable' || db.status === 'suspended' || db.status === 'expired' || (days !== null && days < 0);
  const blocked = unavailable || (db.source === 'odoo' && !authenticated);
  const proposedName = proposeName(db.name, [...discovery.databases.map(d => d.name), ...reserved], now);
  const steps: SimulationStep[] = [
    { label: 'Authentication', status: db.source === 'demo' ? 'not-performed' : authenticated ? 'passed' : 'blocked', detail: db.source === 'demo' ? 'Sample dataset. No account session used.' : authenticated ? 'Read-only session confirmed for the latest discovery.' : 'Reconnect and refresh before relying on this cached snapshot.' },
    { label: 'Original database', status: 'passed', detail: `Found in ${db.source === 'demo' ? 'sample data' : 'the visible manager list'} at ${db.observedAt}.` },
    { label: 'Expiration', status: db.expiresAt ? 'passed' : 'requires-verification', detail: db.expiresAt ? `Observed expiration: ${db.expiresAt}. No future extension inferred.` : db.remainingDays != null ? `Manage page reported ${db.remainingDays} days remaining at ${db.expirationObservedAt ?? db.observedAt}. The exact expiration date is not provided.` : 'Unknown. No date has been inferred from creation time or database type.' },
    { label: 'Duplication eligibility', status: blocked ? 'blocked' : 'requires-verification', detail: unavailable ? 'Observed state or unavailable control prevents an eligible plan.' : 'Control availability does not establish permission, quota, trial eligibility, or eligibility of a duplicate.' },
    { label: 'Proposed name', status: 'passed', detail: `${proposedName} has no conflict in this snapshot or batch. Global availability is not checked or reserved.` },
    { label: 'Duplicate creation', status: 'simulated', detail: `Would request a testing copy named ${proposedName}, with external actions neutralized. No request is sent.` },
    { label: 'Duplicate integrity verification', status: 'not-performed', detail: 'Live deletion always requires a distinct database identity, successful completion, neutralization and confirmed expiration. Safe mode also requires your integrity checks. This simulation creates no copy to verify.' },
    { label: 'Original deletion', status: 'simulated', detail: 'SIMULATED ONLY. Safe mode requires your integrity, backup and subscription confirmations. Automatic mode uses identity, activation, expiry and permission gates. This report authorizes neither mode.' },
  ];
  return {
    id: crypto.randomUUID(), timestamp: now.toISOString(), databaseId: db.id, databaseName: db.name, source: db.source,
    expirationDate: db.expiresAt, daysRemaining: days, proposedName, trigger, eventKey: eventKey(db),
    eligibility: blocked ? 'blocked' : 'requires-verification', steps,
    warnings: [...new Set([
      'Odoo documents a 15-day lifetime and a limit of five duplicates per source; account-specific exceptions require verification.',
      'A copy may inherit its parent’s expiry. The app reads the actual expiry and does not promise an extension.',
      'No duplicate was created, verified, or deleted. This report is a plan only.',
      ...(db.deletion === 'unavailable' ? ['Deletion control is unavailable.'] : []),
      ...(db.subscription === 'linked' ? ['Subscription-linked database: deletion may close the subscription. Verify with Odoo.'] : []),
      ...(db.designation === 'production' ? ['Production database: integrity, continuity, backup, and subscription review are mandatory for any future workflow.'] : []),
      ...(discovery.coverage === 'partial' ? ['Discovery is partial. Naming conflicts may be missing.'] : []),
      ...db.restrictions,
    ])], finalStatus: 'NO CHANGES MADE',
  };
}

import type { Simulation } from '../shared/types';
// Explicit projection: no browser context, raw HTML, headers, URL parameters, or session fields.
export function exportReports(records: Simulation[]): object {
  return { formatVersion: 1, mode: 'READ-ONLY SIMULATION', exportedAt: new Date().toISOString(), reports: records.map(r => ({
    id: r.id, timestamp: r.timestamp, databaseName: r.databaseName, source: r.source,
    expirationDate: r.expirationDate, daysRemaining: r.daysRemaining, proposedName: r.proposedName,
    trigger: r.trigger, eligibility: r.eligibility,
    steps: r.steps.map(s => ({ label: s.label, status: s.status, detail: s.detail })), warnings: [...r.warnings], finalStatus: r.finalStatus,
  })) };
}

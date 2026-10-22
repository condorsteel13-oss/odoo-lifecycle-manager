import type { Database, Settings, Simulation } from '../shared/types';
import { daysRemaining } from './dates';
export function eventKey(db: Database): string { return JSON.stringify([db.source, db.id, db.expiresAt]); }
export function matchesRule(db: Database, settings: Settings, now = new Date()): boolean {
  const days = daysRemaining(db.expiresAt, now);
  return days !== null && days >= 0 && days <= settings.thresholdDays && db.status !== 'expired' && db.status !== 'suspended' && (settings.scope === 'all' || settings.databaseIds.includes(db.id));
}
export function dueDatabases(databases: Database[], settings: Settings, history: Simulation[], now = new Date()): Database[] {
  const seen = new Set(history.filter(s => s.trigger === 'automatic').map(s => s.eventKey));
  return databases.filter(db => matchesRule(db, settings, now) && !seen.has(eventKey(db)));
}
export function nextCheck(lastAttempt: string | null, settings: Settings, now = new Date()): Date | null {
  if (!settings.monitoringEnabled&&!settings.lifecycleEnabled) return null;
  return lastAttempt ? new Date(Date.parse(lastAttempt) + settings.intervalHours * 3600000) : now;
}

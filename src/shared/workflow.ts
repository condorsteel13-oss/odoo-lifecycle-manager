import type { LiveRecord } from './live';

export interface WorkflowPreferences {
  activationEmailDelayMinutes: number;
  copyNameTemplate: string;
}
export const DEFAULT_WORKFLOW_PREFERENCES: WorkflowPreferences = {
  activationEmailDelayMinutes: 3,
  copyNameTemplate: '{name}-copy-{date}',
};

// Saved per copy so changing settings cannot move an in-flight delivery deadline.
export function activationEmailWaitMs(record: LiveRecord, fallbackMinutes = 3, now = Date.now()): number {
  if (record.phase !== 'activation-pending' || !record.activation || record.activation.link !== 'not-started' || record.activation.completion === 'pending') return 0;
  const created = Date.parse(record.copyReadyAt ?? record.createdAt);
  const sent = record.activation.sentAt ? Date.parse(record.activation.sentAt) : created;
  const start = Math.max(created, sent);
  if (!Number.isFinite(start)) return Infinity; // A malformed legacy timestamp cannot bypass the wait.
  return Math.max(0, start + (record.activationEmailDelayMinutes ?? fallbackMinutes) * 60_000 - now);
}
export function waitLabel(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

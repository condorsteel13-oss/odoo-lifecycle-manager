import type { AppState, Diagnostic } from '../shared/types';
import type { LiveRecord } from '../shared/live';
import type { LifecycleProgress } from '../shared/progress';

export interface LogRange { from: string; to: string }
export const LOG_PERIODS = [
  ['hour', 'Last hour'], ['today', 'Today'], ['week', 'Last week (7 days)'],
  ['month', 'Last month'], ['quarter', 'Last 3 months'], ['year', 'Last year'],
  ['all', 'All time'], ['custom', 'Custom dates'],
] as const;
export type LogPeriod = typeof LOG_PERIODS[number][0];

function monthsAgo(now: Date, months: number) {
  const date = new Date(now), day = date.getDate();
  date.setDate(1); date.setMonth(date.getMonth() - months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay)); return date;
}
function localDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('Choose a start and end date.');
  const [year, month, day] = value.split('-').map(Number), date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw Error('Choose valid calendar dates.');
  return date;
}
export function logRange(period: LogPeriod, now = new Date(), start = '', end = ''): LogRange {
  let from = new Date(0), to = new Date(now.getTime() + 1);
  switch (period) {
    case 'hour': from = new Date(now.getTime() - 3600000); break;
    case 'today': from = new Date(now); from.setHours(0, 0, 0, 0); break;
    case 'week': from = new Date(now); from.setDate(from.getDate() - 7); break;
    case 'month': from = monthsAgo(now, 1); break;
    case 'quarter': from = monthsAgo(now, 3); break;
    case 'year': from = monthsAgo(now, 12); break;
    case 'custom': from = localDay(start); to = localDay(end); to.setDate(to.getDate() + 1); break;
  }
  if (from >= to) throw Error('The end date must be on or after the start date.');
  return { from: from.toISOString(), to: to.toISOString() };
}
export function logOverlaps(record: LiveRecord, range: LogRange) {
  return Date.parse(record.createdAt) < Date.parse(range.to) && Date.parse(record.updatedAt) >= Date.parse(range.from);
}
// Project known fields only. Never include sessions, raw responses, activation URLs,
// email addresses, backup locations, user-entered integrity notes or mailbox content.
export function debugText(value: string) {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, '[URL omitted]')
    .replace(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, '[authorization omitted]')
    .replace(/\b(password|passwd|secret|(?:access[_-]?|refresh[_-]?|csrf[_-]?|session[_-]?)?token|authorization|cookie|session(?:_id)?|api[_-]?key)["']?\s*[:=]\s*["']?[^,\s;"'}]+/gi, '$1=[redacted]');
}
function progress(value: LifecycleProgress | undefined) {
  return value && { step: value.step, status: value.status, percent: value.percent, at: value.at,
    message: debugText(value.message), ...(value.detail ? { detail: debugText(value.detail) } : {}) };
}
function database(value: LiveRecord['original'] | null) {
  return value && { name: value.name, uuid: value.uuid, version: value.version, source: value.source,
    status: value.status, designation: value.designation, subscription: value.subscription,
    expiresAt: value.expiresAt, remainingDays: value.remainingDays, observedAt: value.observedAt,
    expirationObservedAt: value.expirationObservedAt, duplication: value.duplication, deletion: value.deletion };
}
export function exportLiveLog(state: AppState, range: LogRange, appVersion: string, now = new Date()) {
  const inside = (date: string) => Date.parse(date) >= Date.parse(range.from) && Date.parse(date) < Date.parse(range.to);
  const records = state.liveHistory.filter(record => logOverlaps(record, range));
  return {
    formatVersion: 1, kind: 'LIVE_ACTION_DEBUG', appVersion, exportedAt: now.toISOString(), range,
    selection: 'Runs overlapping the range; each matching run includes its full step history. End timestamp is exclusive.',
    workspace: state.discovery?.source ?? 'demo',
    settings: { monitoringEnabled: state.settings.monitoringEnabled, lifecycleEnabled: state.settings.lifecycleEnabled,
      deleteAfterActivation: state.settings.deleteAfterActivation, thresholdDays: state.settings.thresholdDays,
      intervalHours: state.settings.intervalHours, scope: state.settings.scope, safeMode: state.lifecyclePreferences.safeMode,
      backgroundChrome: state.browserPreferences.headless, activationEmailDelayMinutes: state.workflowPreferences.activationEmailDelayMinutes,
      copyNameTemplate: state.workflowPreferences.copyNameTemplate },
    connections: { odoo: state.connection, viamail: state.mailConnection.status },
    records: records.map(record => ({
      id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, phase: record.phase,
      workflow: record.workflow, scheduledId: record.scheduledId, deleteOriginal: record.deleteOriginal,
      original: database(record.original), originalUuid: record.originalUuid,
      copyName: record.copyName, copy: database(record.copy), copyUuid: record.copyUuid,
      message: debugText(record.message), progress: progress(record.progress),
      progressEvents: record.progressEvents?.map(progress), copyReadyAt: record.copyReadyAt,
      activationEmailDelayMinutes: record.activationEmailDelayMinutes,
      activation: record.activation && { send: record.activation.send, sentAt: record.activation.sentAt,
        link: record.activation.link, completion: record.activation.completion },
      verifiedAt: record.verifiedAt, activationVerifiedAt: record.activationVerifiedAt,
      activationExpiresAt: record.activationExpiresAt, retainedAt: record.retainedAt, removal: record.removal,
    })),
    diagnostics: state.diagnostics.filter((entry: Diagnostic) => inside(entry.timestamp)).map(entry => ({
      timestamp: entry.timestamp, code: entry.code, message: debugText(entry.message),
    })),
  };
}

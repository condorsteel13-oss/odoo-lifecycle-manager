import { describe, expect, it } from 'vitest';
import { debugText, exportLiveLog, logOverlaps, logRange } from '../src/domain/live-export';
import { demoDiscovery, DEFAULT_SETTINGS } from '../src/domain/demo';
import { DEFAULT_WORKFLOW_PREFERENCES } from '../src/shared/workflow';
import type { LiveRecord } from '../src/shared/live';
import type { AppState } from '../src/shared/types';
import { liveExportRangeSchema } from '../electron/schemas';

function record(createdAt: string, updatedAt = createdAt): LiveRecord {
  return { id: '11111111-1111-4111-8111-111111111111', createdAt, updatedAt,
    original: demoDiscovery().databases[0], originalUuid: '22222222-2222-4222-8222-222222222222',
    copyName: 'fixture-copy', phase: 'activation-pending', copy: null, copyUuid: null,
    verifiedAt: null, message: 'Waiting for activation', backupReference: 'PRIVATE BACKUP', integrityNotes: 'PRIVATE NOTES' };
}
describe('debug log periods and boundaries', () => {
  it('uses a rolling hour, local midnight, and seven calendar days', () => {
    const now = new Date(2026, 9, 23, 11, 15, 30);
    expect(logRange('hour', now)).toEqual({ from: new Date(now.getTime() - 3600000).toISOString(), to: new Date(now.getTime() + 1).toISOString() });
    expect(logRange('today', now).from).toBe(new Date(2026, 9, 23).toISOString());
    expect(logRange('week', now).from).toBe(new Date(2026, 9, 16, 11, 15, 30).toISOString());
  });
  it('clamps calendar months and leap years without rolling into the wrong month', () => {
    expect(logRange('month', new Date(2026, 2, 31, 12)).from).toBe(new Date(2026, 1, 28, 12).toISOString());
    expect(logRange('quarter', new Date(2026, 4, 31, 12)).from).toBe(new Date(2026, 1, 28, 12).toISOString());
    expect(logRange('year', new Date(2024, 1, 29, 12)).from).toBe(new Date(2023, 1, 28, 12).toISOString());
  });
  it('includes the entire custom end day using local calendar boundaries', () => {
    const range = logRange('custom', new Date(), '2026-03-08', '2026-03-08');
    expect(range).toEqual({ from: new Date(2026, 2, 8).toISOString(), to: new Date(2026, 2, 9).toISOString() });
    expect(logOverlaps(record(range.from), range)).toBe(true);
    expect(logOverlaps(record(new Date(Date.parse(range.to) - 1).toISOString()), range)).toBe(true);
    expect(logOverlaps(record(range.to), range)).toBe(false);
    expect(logOverlaps(record('2026-01-01T00:00:00Z', range.to), range)).toBe(true);
  });
  it('rejects missing, reversed, invalid dates and extra IPC fields', () => {
    expect(() => logRange('custom')).toThrow();
    expect(() => logRange('custom', new Date(), '2026-02-30', '2026-03-03')).toThrow();
    expect(() => logRange('custom', new Date(), '2026-10-24', '2026-10-23')).toThrow();
    const range = logRange('all');
    expect(liveExportRangeSchema.safeParse(range).success).toBe(true);
    expect(liveExportRangeSchema.safeParse({ ...range, path: '/arbitrary/file' }).success).toBe(false);
    expect(liveExportRangeSchema.safeParse({ from: range.to, to: range.from }).success).toBe(false);
  });
});
it('exports only matching runs, with full step context and safe diagnostic fields', () => {
  const current = record('2026-10-22T00:00:00Z', '2026-10-23T12:15:00Z');
  current.message = 'Open https://fixture.odoo.com/confirm?token=PRIVATE_LINK for user@example.com';
  current.activation = { userEmail: 'PRIVATE_USER@example.com', recipientEmail: 'PRIVATE_RECIPIENT@example.com', send: 'sent', sentAt: current.createdAt, link: 'opened' };
  current.progressEvents = [{ step: 'created', status: 'done', message: 'Copy created', percent: 35, at: current.createdAt },
    { step: 'activating', status: 'failed', message: 'Activation failed', percent: 60, at: current.updatedAt, detail: 'Bearer PRIVATE_AUTH password=PRIVATE_PASSWORD {"accessToken":"PRIVATE_TOKEN"}' }];
  const state = { settings: { ...DEFAULT_SETTINGS, privateExtra: 'PRIVATE_SETTINGS' }, workflowPreferences: DEFAULT_WORKFLOW_PREFERENCES,
    lifecyclePreferences: { safeMode: true }, browserPreferences: { headless: true }, connection: 'connected', mailConnection: { status: 'connected', email: 'PRIVATE_MAIL@example.com' },
    discovery: demoDiscovery(), liveHistory: [current, record('2026-09-01T00:00:00Z')], cookies: 'PRIVATE_COOKIES',
    diagnostics: [{ timestamp: '2026-10-23T12:10:00Z', code: 'TEST', message: 'cookie=PRIVATE_COOKIE' },
      { timestamp: '2026-09-01T00:00:00Z', code: 'OLD', message: 'Old message' }],
  } as unknown as AppState;
  const range = { from: '2026-10-23T12:00:00Z', to: '2026-10-23T13:00:00Z' };
  const result = exportLiveLog(state, range, '1.8.8');
  expect(result.records).toHaveLength(1); expect(result.records[0].progressEvents).toHaveLength(2);
  expect(result.records[0].copyName).toBe('fixture-copy'); expect(result.records[0].activation?.send).toBe('sent');
  expect(result.diagnostics).toHaveLength(1);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|user@example|\/confirm\?|backupReference|integrityNotes|userEmail|recipientEmail/);
  expect(current.message).toContain('PRIVATE_LINK'); // Export never modifies the source log.
  expect(debugText('Authorization: Basic abc123== refresh_token=SECRET')).not.toMatch(/abc123|SECRET/);
});

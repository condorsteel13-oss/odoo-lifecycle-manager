import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { demoDiscovery, DEFAULT_SETTINGS } from '../src/domain/demo';
import { daysRemaining, validDate } from '../src/domain/dates';
import { matchesRule, dueDatabases, nextCheck } from '../src/domain/monitor';
import { simulate, proposeName } from '../src/domain/simulation';
import { exportReports } from '../src/domain/export';
const now = new Date('2026-10-19T12:00:00Z');
const discovery = demoDiscovery(now);
const settings = { ...DEFAULT_SETTINGS, monitoringEnabled: true };
describe('expiration and monitoring', () => {
  it.each([[1, true], [3, true], [30, false], [-2, false]])('handles %i days remaining', (days, expected) => {
    const db = { ...discovery.databases[0], status: 'active' as const, expiresAt: `2026-${days === 30 ? '11-18' : `10-${19 + days}`}` };
    expect(daysRemaining(db.expiresAt, now)).toBe(days);
    expect(matchesRule(db, settings, now)).toBe(expected);
  });
  it('never treats an unknown date as zero', () => expect(matchesRule({ ...discovery.databases[0], expiresAt: null }, settings, now)).toBe(false));
  it('handles date-only boundaries, exact instants, leap dates, and expired-within-a-day', () => {
    expect(daysRemaining('2026-10-19', now)).toBe(0);
    expect(daysRemaining('2026-10-19T11:59:00Z', now)).toBe(-1);
    expect(daysRemaining('2026-10-19T12:01:00Z', now)).toBe(1);
    expect(validDate('2026-02-30')).toBe(false);
    expect(validDate('2028-02-29')).toBe(true);
  });
  it('respects explicit database scope and skips suspended databases', () => {
    expect(matchesRule(discovery.databases[0], { ...settings, scope: 'selected', databaseIds: [] }, now)).toBe(false);
    expect(matchesRule({ ...discovery.databases[0], status: 'suspended' }, settings, now)).toBe(false);
  });
  it('deduplicates automatic events across saved history, including blocked plans', () => {
    const first = dueDatabases(discovery.databases, settings, [], now);
    expect(first).toHaveLength(3);
    const reports = first.map(db => simulate(db, discovery, 'automatic', false, now));
    expect(dueDatabases(discovery.databases, settings, JSON.parse(JSON.stringify(reports)), now)).toHaveLength(0);
    expect(dueDatabases([{ ...first[0], expiresAt: '2026-10-22' }], settings, reports, now)).toHaveLength(1);
  });
  it('manual reports do not suppress the first automatic check', () => {
    const report = simulate(discovery.databases[0], discovery, 'manual', false, now);
    expect(dueDatabases(discovery.databases, settings, [report], now)).toHaveLength(3);
  });
  it('uses attempts to schedule retry and never catches up every missed interval', () => {
    expect(nextCheck(now.toISOString(), settings, now)?.toISOString()).toBe('2026-10-19T18:00:00.000Z');
    expect(nextCheck(null, { ...settings, monitoringEnabled: false }, now)).toBeNull();
    expect(nextCheck(null,{...settings,monitoringEnabled:false,lifecycleEnabled:true},now)).toEqual(now);
  });
});
describe('simulations cannot execute', () => {
  it('does not call the network for any scenario or claim actual duplication', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    for (const db of discovery.databases) {
      const report = simulate(db, discovery, 'manual', false, now);
      expect(report.finalStatus).toBe('NO CHANGES MADE');
      expect(report.steps.find(s => s.label === 'Duplicate creation')?.status).toBe('simulated');
      expect(report.steps.find(s => s.label === 'Duplicate integrity verification')?.status).toBe('not-performed');
      expect(report.steps.find(s => s.label === 'Original deletion')?.status).toBe('simulated');
    }
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  });
  it('blocks unavailable duplication and duplicate-limit scenarios', () => {
    expect(simulate(discovery.databases[5], discovery, 'manual', false, now).eligibility).toBe('blocked');
    expect(simulate(discovery.databases[3], discovery, 'manual', false, now).eligibility).toBe('blocked');
  });
  it('includes deletion and production subscription warnings', () => {
    const report = simulate(discovery.databases[2], discovery, 'manual', false, now);
    expect(report.warnings.join(' ')).toMatch(/Deletion control is unavailable/);
    expect(report.warnings.join(' ')).toMatch(/Subscription-linked/);
    expect(report.warnings.join(' ')).toMatch(/Production database/);
  });
  it('does not label expired sessions authenticated', () => {
    const db = { ...discovery.databases[0], source: 'odoo' as const };
    const report = simulate(db, { ...discovery, source: 'odoo', databases: [db] }, 'manual', false, now);
    expect(report.steps[0].status).toBe('blocked'); expect(report.eligibility).toBe('blocked');
  });
  it('makes unique bounded name proposals, never reserves them', () => {
    const base = proposeName('Company test', [], now);
    expect(base).toBe('company-test-copy-20261019');
    expect(proposeName('Company test', [base, `${base}-2`], now)).toBe(`${base}-3`);
    const long=proposeName('A'.repeat(100), [], now);expect(long.length).toBeLessThanOrEqual(50);
    const next=proposeName('A'.repeat(100), [long], now);expect(next.length).toBeLessThanOrEqual(50);expect(next).not.toBe(long);expect(next).toMatch(/-2$/);
  });
  it('has no execution or browser dependencies', () => {
    const source = readFileSync('src/domain/simulation.ts', 'utf8');
    expect(source).not.toMatch(/from ['"](?:playwright|electron|node:|https?:)/);
    expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|require)\s*\(/);
  });
  it('projects reports without session data and rejects added top-level fields', () => {
    const report = { ...simulate(discovery.databases[0], discovery, 'manual', false, now), cookies: 'SECRET_COOKIE', password: 'SECRET_PASSWORD', html: 'SECRET_HTML', session: 'SECRET_SESSION' };
    const exported = JSON.stringify(exportReports([report]));
    expect(exported).not.toMatch(/SECRET_/);
    expect(exported).toContain('NO CHANGES MADE');
  });
});

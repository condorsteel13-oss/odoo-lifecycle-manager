import type { Database, Discovery, Settings } from '../shared/types';
import { localCalendarDate } from './dates';
export const DEFAULT_SETTINGS: Settings = { monitoringEnabled: false, lifecycleEnabled:false, deleteAfterActivation:false, thresholdDays: 3, intervalHours: 6, scope: 'all', databaseIds: [] };
export function demoDiscovery(now = new Date()): Discovery {
  function date(days: number) { const d = new Date(now); d.setDate(d.getDate() + days); return localCalendarDate(d); }
  const seed: Array<Partial<Database> & Pick<Database, 'name' | 'expiresAt'>> = [
    { name: 'atlas-staging', expiresAt: date(1), designation: 'testing', status: 'trial', duplication: 'available', deletion: 'available' },
    { name: 'northwind-sandbox', expiresAt: date(3), designation: 'testing', duplication: 'unknown' },
    { name: 'atlas-production', expiresAt: date(30), designation: 'production', subscription: 'linked', deletion: 'unavailable' },
    { name: 'migration-archive', expiresAt: date(-2), status: 'expired', duplication: 'unavailable', deletion: 'unavailable' },
    { name: 'studio-experiments', expiresAt: null, designation: 'testing' },
    { name: 'northwind-qa', expiresAt: date(2), designation: 'testing', duplication: 'unavailable', restrictions: ['Duplicate limit reached (sample scenario).'] },
  ];
  return { source: 'demo', refreshedAt: now.toISOString(), coverage: 'visible-list', pages: 1, warnings: ['Sample data only. These are not your Odoo databases.'], databases: seed.map((s, i) => ({
    id: `demo-${i}`, url: null, version: '19.0', createdAt: date(-12), expirationEvidence: s.expiresAt ? 'Synthetic date for demonstration' : null,
    status: 'active', designation: 'unknown', subscription: 'unknown', duplication: 'unknown', deletion: 'unknown', restrictions: [], observedAt: now.toISOString(), source: 'demo', ...s,
  })) };
}

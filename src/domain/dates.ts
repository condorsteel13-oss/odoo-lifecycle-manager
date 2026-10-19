const DAY = 86_400_000;
export function dateOnly(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value); }
export function validDate(value: string): boolean {
  if (dateOnly(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
export function localCalendarDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function daysRemaining(expiresAt: string | null, now = new Date()): number | null {
  if (!expiresAt || !validDate(expiresAt)) return null;
  if (dateOnly(expiresAt)) return Math.round((Date.parse(`${expiresAt}T00:00:00Z`) - Date.parse(`${localCalendarDate(now)}T00:00:00Z`)) / DAY);
  const diff = Date.parse(expiresAt) - now.getTime();
  return diff < 0 ? Math.min(-1, Math.ceil(diff / DAY)) : Math.ceil(diff / DAY);
}
export function formatDate(value: string | null): string {
  if (!value || !validDate(value)) return 'Unknown';
  return new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', year: 'numeric', ...(dateOnly(value) ? { timeZone: 'UTC' } : {}) }).format(new Date(dateOnly(value) ? `${value}T00:00:00Z` : value));
}

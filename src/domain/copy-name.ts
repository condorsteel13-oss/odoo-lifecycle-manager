import { DEFAULT_WORKFLOW_PREFERENCES } from '../shared/workflow';

export function copyNameTemplateError(template: string): string | null {
  if ((template.match(/\{name\}/g) ?? []).length !== 1) return 'Include {name} exactly once for the original database name.';
  if (!/^(?:[a-z0-9-]|\{name\}|\{date\})+$/.test(template) || (template.match(/\{date\}/g) ?? []).length > 1) return 'Use lowercase letters, numbers, hyphens, {name}, and optionally one {date}.';
  const fixed = template.replace('{name}', '').replace('{date}', '20261021');
  if (fixed.length > 40) return 'Keep the text outside {name}, including the eight-digit date, within 40 characters.';
  return null;
}

export function proposeName(name: string, existing: string[], now: Date, template = DEFAULT_WORKFLOW_PREFERENCES.copyNameTemplate): string {
  const error = copyNameTemplateError(template);
  if (error) throw new Error(error);
  const stem = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'database';
  const dated = template.replace('{date}', now.toISOString().slice(0, 10).replaceAll('-', ''));
  const fixedLength = dated.replace('{name}', '').length;
  const used = new Set(existing.map(n => n.toLowerCase()));
  for (let suffix = 1; ; suffix++) {
    const tail = suffix === 1 ? '' : `-${suffix}`;
    const shortened = stem.slice(0, 50 - fixedLength - tail.length).replace(/-$/, '');
    const base = dated.replace('{name}', shortened).replace(/-+/g, '-').replace(/^-|-$/g, '');
    const candidate = `${base.length < 4 ? `${base}-copy` : base}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
}

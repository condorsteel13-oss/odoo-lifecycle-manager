import type { Database } from './types';

// Protect accounting databases across accounts without embedding customer names.
export function isProtected(name: string) {
  const databaseName = name.toLowerCase().replace(/^https:\/\//, '').replace(/\.odoo\.com$/, '');
  return /(^|-)accounting(-|$)/.test(databaseName);
}
export type LivePhase = 'duplicate-submitting' | 'duplicate-unknown' | 'awaiting-copy' | 'activation-pending' | 'awaiting-expiry' | 'copy-verified' | 'delete-submitting' | 'delete-unknown' | 'deleted' | 'copy-removed';
export interface ActivationRecord {
  userEmail: string; recipientEmail: string | null;
  send: 'not-needed' | 'sending' | 'sent' | 'unknown'; sentAt: string | null;
  link: 'not-started' | 'opening' | 'opened' | 'unknown';
}
export interface LiveRecord {
  id: string; createdAt: string; updatedAt: string;
  original: Database; originalUuid: string; copyName: string;
  originalParentUuid?: string | null;
  workflow?: 'guided' | 'automatic';
  workflowStartedAt?: string;
  scheduledId?:string;
  activation?: ActivationRecord;
  activationVerifiedAt?: string | null;
  activationExpiresAt?: string | null;
  removal?: { userReportedRemoved: true; checkedAt: string; previousPhase: 'activation-pending' | 'awaiting-expiry' | 'copy-verified' };
  phase: LivePhase; copy: Database | null; copyUuid: string | null;
  verifiedAt: string | null; message: string;
  backupReference: string | null; integrityNotes: string | null;
}
export interface LiveReview {
  ticket: string; expiresAt: string; action: 'duplicate' | 'delete';
  original: Database; copyName: string; copy: Database | null; recordId: string | null;
  workflow?: 'guided' | 'automatic';
  scheduledId?:string;
}
export interface LiveConfirmation {
  ticket: string; typedName: string; acknowledged: boolean;
  backupConfirmed?: boolean; backupReference?: string;
  integrityConfirmed?: boolean; integrityNotes?: string; subscriptionReviewed?: boolean;
}
export function validCopyName(name: string) { return /^[a-z0-9][a-z0-9-]{2,48}[a-z0-9]$/.test(name) && !isProtected(name); }

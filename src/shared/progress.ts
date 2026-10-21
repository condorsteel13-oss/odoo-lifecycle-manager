import type { LiveRecord } from './live';

export const PROGRESS_STEPS = ['preparing', 'duplicating', 'duplicate-done', 'created', 'waiting-email', 'email-received', 'activating', 'activation-done', 'verifying', 'awaiting-deletion', 'deleting', 'deleted', 'retained'] as const;
export const PROGRESS_STATUSES = ['running', 'done', 'waiting', 'failed', 'stopped', 'uncertain'] as const;
export type ProgressStep = typeof PROGRESS_STEPS[number];
export type ProgressStatus = typeof PROGRESS_STATUSES[number];
export interface LifecycleProgress {
  step: ProgressStep; status: ProgressStatus; message: string; percent: number; at: string; detail?: string;
}
const percentages: Record<ProgressStep, number> = {preparing:0,duplicating:10,'duplicate-done':30,created:35,'waiting-email':40,'email-received':50,activating:60,'activation-done':75,verifying:80,'awaiting-deletion':85,deleting:90,deleted:100,retained:100};

export function makeProgress(original: string, copy: string, step: ProgressStep, status: ProgressStatus, detail?: string): LifecycleProgress {
  const messages: Record<ProgressStep, string> = {
    preparing:`Preparing ${original}`, duplicating:`Duplicating ${original}`,
    'duplicate-done':`${original} duplication done`, created:`${copy} created`,
    'waiting-email':`${copy} created, waiting for activation email`,
    'email-received':`Activation email received for ${copy}`, activating:`Activating ${copy}`,
    'activation-done':`${copy} activation done`, verifying:`Verifying ${copy} and its expiry`,
    'awaiting-deletion':`Waiting for confirmation to delete ${original}`, deleting:`Deleting ${original}`,
    deleted:`${original} deleted`, retained:`${copy} activation done — both databases retained`,
  };
  const actions: Record<ProgressStep, string> = {
    preparing:`Preparation for ${original}`, duplicating:`Duplication of ${original}`, 'duplicate-done':`Duplication of ${original}`,
    created:`Creation of ${copy}`, 'waiting-email':`Activation email check for ${copy}`, 'email-received':`Activation email check for ${copy}`,
    activating:`Activation of ${copy}`, 'activation-done':`Activation of ${copy}`, verifying:`Verification of ${copy}`,
    'awaiting-deletion':`Deletion of ${original}`, deleting:`Deletion of ${original}`, deleted:`Deletion of ${original}`, retained:`Completion for ${copy}`,
  };
  const message=status==='failed'?`${actions[step]} unsuccessful`:status==='stopped'?`${actions[step]} interrupted`:status==='uncertain'?`${actions[step]} not confirmed — outcome uncertain`:messages[step];
  return {step,status,message,percent:status==='done'?percentages[step]:Math.min(95,percentages[step]),at:new Date().toISOString(),...(detail?{detail}:{})};
}

export function withProgress(record: LiveRecord, step: ProgressStep, status: ProgressStatus, detail?: string): LiveRecord {
  if(record.progress?.step===step&&record.progress.status===status&&record.progress.detail===detail)return record;
  const progress=makeProgress(record.original.name,record.copyName,step,status,detail);
  const events=record.progressEvents??[],last=events.at(-1);
  const replace=last?.step===step&&['running','waiting'].includes(last.status)&&['running','waiting'].includes(status);
  return {...record,progress,progressEvents:[...(replace?events.slice(0,-1):events),progress].slice(-60)};
}

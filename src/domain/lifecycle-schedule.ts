import type { Database, ScheduledCycle, Settings } from '../shared/types';
import { isProtected, type LiveRecord } from '../shared/live';
import { daysRemaining } from './dates';
const DAY=86400000;
// Approximate countdown boundaries are used only to suppress repeat work, never
// displayed as exact expiry dates or used to pass the deletion verification gate.
function boundary(db:Database){
  if(db.expiresAt)return Date.parse(db.expiresAt);
  const observed=Date.parse(db.expirationObservedAt??'');
  return db.remainingDays!=null&&Number.isFinite(observed)?observed+db.remainingDays*DAY:NaN;
}
export function matchesLifecycleRule(db:Database,settings:Settings,now=new Date()){
  const observed=Date.parse(db.expirationObservedAt??db.observedAt),days=daysRemaining(db.expiresAt,now)??db.remainingDays??null;
  return db.source==='odoo'&&!!db.uuid&&!isProtected(db.name)&&!isProtected(db.id)&&Number.isFinite(observed)&&now.getTime()-observed<10*60000&&observed<=now.getTime()+60000&&days!==null&&days>=0&&days<=settings.thresholdDays&&!['expired','suspended'].includes(db.status)&&(settings.scope==='all'||settings.databaseIds.includes(db.id));
}
export function scheduledCandidates(databases:Database[],settings:Settings,jobs:ScheduledCycle[],records:LiveRecord[],now=new Date()){
  return databases.filter(db=>{
    if(!matchesLifecycleRule(db,settings,now))return false;
    const current=boundary(db);if(!Number.isFinite(current))return false;
    if(jobs.some(job=>job.database.uuid===db.uuid&&(!['complete','dismissed'].includes(job.status)||current<=boundary(job.database)+DAY)))return false;
    // A copy with an inherited expiry must not trigger an endless copy/delete
    // chain. Require a later expiration event before scheduling that copy.
    return !records.some(record=>(record.copyUuid===db.uuid||record.copyName===db.name)&&current<=Math.max(boundary(record.original)||0,record.copy?boundary(record.copy)||0:0,Date.parse(record.activationExpiresAt??'')||0)+DAY);
  });
}

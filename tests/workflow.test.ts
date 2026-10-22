import { describe, expect, it } from 'vitest';
import { proposeName } from '../src/domain/copy-name';
import { validCopyName } from '../src/shared/live';
import { DEFAULT_WORKFLOW_PREFERENCES } from '../src/shared/workflow';
import { workflowPreferencesSchema } from '../electron/schemas';

const now=new Date('2026-10-21T12:00:00Z');
describe('copy naming preferences',()=>{
  it.each([
    ['{name}-copy','example-db-copy'],
    ['backup-{name}-{date}','backup-example-db-20261021'],
    ['{name}-sandbox','example-db-sandbox'],
    ['{name}','example-db-2'],
  ])('expands %s and avoids the original name', (template,expected)=>{
    expect(proposeName('example-db',['example-db'],now,template)).toBe(expected);
  });
  it('reserves historical and batch names regardless of case',()=>{
    expect(proposeName('example-db',['EXAMPLE-DB-COPY','example-db-copy-2'],now,'{name}-copy')).toBe('example-db-copy-3');
  });
  it('preserves custom affixes and uniqueness when long names must be shortened',()=>{
    const used:string[]=[];
    for(let i=0;i<15;i++){
      const value=proposeName('a'.repeat(100),used,now,'backup-{name}-{date}-copy');
      expect(value).toMatch(/^backup-a+-20261021-copy(?:-\d+)?$/);
      expect(validCopyName(value)).toBe(true);
      expect(used).not.toContain(value);used.push(value);
    }
  });
  it.each(['copy','{name}-{name}','{name}-{time}','{name}-{date}-{date}','{name}/copy','{name} copy','{name}-COPY','{name}-'+'x'.repeat(41)])('rejects invalid template %s',copyNameTemplate=>{
    expect(workflowPreferencesSchema.safeParse({...DEFAULT_WORKFLOW_PREFERENCES,copyNameTemplate}).success).toBe(false);
    expect(()=>proposeName('example-db',[],now,copyNameTemplate)).toThrow();
  });
  it.each([-1,61,1.5,NaN,Infinity,'3'])('rejects invalid delay %s',activationEmailDelayMinutes=>{
    expect(workflowPreferencesSchema.safeParse({...DEFAULT_WORKFLOW_PREFERENCES,activationEmailDelayMinutes}).success).toBe(false);
  });
  it.each([0,3,60])('accepts a whole delay of %i minutes',activationEmailDelayMinutes=>{
    expect(workflowPreferencesSchema.safeParse({...DEFAULT_WORKFLOW_PREFERENCES,activationEmailDelayMinutes}).success).toBe(true);
  });
});

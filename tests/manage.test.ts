import {describe,it,expect} from 'vitest';
import {parseManagePage,connectForm,oeaTarget} from '../electron/manage';
import {parseDatabaseList} from '../electron/metadata';
const uuid='11111111-1111-1111-1111-111111111111';
const database=parseDatabaseList({jsonrpc:'2.0',result:{databases:[{db_name:'fixture',uuid,url:'https://fixture.odoo.com'}]}})[0].database;
const page=(banner:string,host='fixture.odoo.com')=>`<html><body><div class="alert">${banner}</div><h3 id="database-section">Database</h3><p>Your database runs on ${host}</p><button>Delete</button></body></html>`;
const form=(action='https://fixture.odoo.com/saas_trial/trial-connect',extra='')=>`<form method="POST" action="${action}"><input type="hidden" name="token" value="SECRET_TOKEN"><input type="hidden" name="db_uuid" value="${uuid}"><input type="hidden" name="redirect" value="https://fixture.odoo.com/auth_oauth/oea?db=fixture">${extra}</form>`;
describe('Manage page metadata',()=>{
 it('records an observed countdown without inventing an exact expiry',()=>{
  const result=parseManagePage(database,page('Your trial will expire in <strong>31</strong> day(s)'),new Date('2026-10-19T17:00:00Z'));
  expect(result).toMatchObject({expiresAt:null,remainingDays:31,expirationObservedAt:'2026-10-19T17:00:00.000Z'});
  expect(result.expirationEvidence).toContain('31 day(s)');
 });
 it('handles zero days, an explicit date, and a successful page with no expiry',()=>{
  expect(parseManagePage(database,page('Your trial will expire in 0 day(s)')).remainingDays).toBe(0);
  expect(parseManagePage(database,page('Your trial expires on 2026-11-19')).expiresAt).toBe('2026-11-19');
  const paid=parseManagePage(database,page(''));
  expect(paid.remainingDays).toBeNull();expect(paid.expiresAt).toBeNull();expect(paid.expirationEvidence).toContain('read successfully');
 });
 it('rejects a different database, unsupported pages and conflicting counters',()=>{
  expect(()=>parseManagePage(database,page('Your trial will expire in 31 day(s)','other.odoo.com'))).toThrow(/identity/);
  expect(()=>parseManagePage(database,'<h1>Login</h1>')).toThrow(/Manage/);
  expect(()=>parseManagePage(database,page('Your trial will expire in 31 day(s)')+'<div class="alert">Your trial will expire in 32 day(s)</div>')).toThrow(/conflicting/);
 });
 it('does not parse scripts, guessed dates or unrelated day counts',()=>{
  const result=parseManagePage(database,page('Backups retained for 31 days')+'<script>Your trial will expire in 31 day(s)</script>');
  expect(result.remainingDays).toBeNull();expect(result.expiresAt).toBeNull();
 });
 it('accepts only the exact authentication form and rejects extra fields and hostile actions',()=>{
  expect(connectForm(form(),database.url!,uuid,'fixture')?.url).toBe(database.url+'/saas_trial/trial-connect');
  for(const html of [form('https://evil.test/saas_trial/trial-connect'),form(database.url+'/my/databases/delete'),form(undefined,'<input type="hidden" name="delete" value="true">'),form().replace('db=fixture','db=other'),form()+form()])expect(connectForm(html,database.url!,uuid,'fixture')).toBeNull();
  for(const url of ['https://fixture.odoo.com/auth_oauth/signin?access_token=secret','https://fixture.odoo.com/auth_oauth/oea?db=other&access_token=secret','https://fixture.odoo.com/auth_oauth/oea?access_token=secret&redirect=/my/databases/delete'])expect(oeaTarget(url,database.url!,'fixture')).toBeNull();
 });
});

const info={db_name:'fixture',db_uuid:uuid,origin_url:'https://fixture.odoo.com',sub_plan:'Trial',expireIn:31,sub_id:false,token:'SECRET',address:{name:'PRIVATE'},payment_token:'PRIVATE'};
const component=(subinfo:object)=>`<owl-component name="openerp_enterprise.MyDatabaseInfo" props='${JSON.stringify({subinfo}).replaceAll("'",'&#39;')}'></owl-component>`;
it('reads the live client-rendered Manage banner without retaining unrelated props',()=>{
 const result=parseManagePage(database,component(info),new Date(),uuid);
 expect(result.remainingDays).toBe(31);expect(result.expiresAt).toBeNull();
 expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|payment_token/);
 expect(parseManagePage(database,component({...info,expireIn:-3}),new Date(),uuid).remainingDays).toBe(-3);
});
it('reads only expiration values that the Manage template displays',()=>{
 expect(parseManagePage(database,component({...info,sub_plan:'InProgress',sub_id:12,until_str:'2027-01-15',days_valid:88}),new Date(),uuid)).toMatchObject({expiresAt:'2027-01-15',remainingDays:null});
 expect(parseManagePage(database,component({...info,sub_plan:'InProgress',sub_id:12,days_valid:12}),new Date(),uuid).remainingDays).toBe(12);
 expect(parseManagePage(database,component({...info,sub_plan:'OneAppFree',expireIn:31,next_invoice_date:'2027-01-15'}),new Date(),uuid)).toMatchObject({expiresAt:null,remainingDays:null});
});
it('requires the exact database identity in Manage component props',()=>{
 for(const patch of [{db_name:'other'},{db_uuid:'22222222-2222-2222-2222-222222222222'},{origin_url:'https://other.odoo.com'}])expect(()=>parseManagePage(database,component({...info,...patch}),new Date(),uuid)).toThrow(/identity/);
 expect(()=>parseManagePage(database,component(info)+component(info),new Date(),uuid)).toThrow(/multiple/);
});

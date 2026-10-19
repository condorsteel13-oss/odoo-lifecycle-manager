import {describe,it,expect} from 'vitest';
import {parseDatabaseList,applySessionExpiration,databaseOrigin} from '../electron/metadata';
const row={db_name:'fixture',uuid:'11111111-1111-1111-1111-111111111111',url:'https://fixture.odoo.com',version:'saas~19.3+e',is_trial:true,is_neutralized:true,has_sub:false,token:'SECRET_TOKEN',auth_url:'SECRET_URL'};
const rpc=(result:unknown)=>({jsonrpc:'2.0',id:1,result});
describe('current Odoo metadata projection',()=>{
 it('projects database metadata without retaining tokens or guessing expiration',()=>{
  const output=parseDatabaseList(rpc({databases:[row]}));
  expect(output[0].database).toMatchObject({name:'fixture',version:'saas~19.3+e',status:'trial',designation:'testing',expiresAt:null});
  expect(JSON.stringify(output)).not.toContain('SECRET');
 });
 it('rejects duplicate identities, external origins and malformed lists',()=>{
  for(const databases of [[row,row],[{...row,url:'https://evil.example'}],[{...row,url:'https://other.odoo.com'}],[{...row,uuid:'not-a-uuid'}]]) expect(()=>parseDatabaseList(rpc({databases}))).toThrow();
  for(const result of [{}, {databases:null}]) expect(()=>parseDatabaseList(rpc(result))).toThrow();
  expect(()=>parseDatabaseList({jsonrpc:'2.0',error:{message:'PRIVATE ERROR'}})).toThrow(/metadata read/);
 });
 it('accepts explicit expiration from a matching authenticated session, serialized in UTC',()=>{
  const database=parseDatabaseList(rpc({databases:[row]}))[0].database;
  expect(applySessionExpiration(database,rpc({uid:2,db:'fixture',expiration_date:'2026-10-22 14:00:00',secret:'SECRET'}))).toMatchObject({expiresAt:'2026-10-22T14:00:00Z'});
  for(const result of [{uid:false,db:'fixture'},{uid:2,db:'other'}]) expect(()=>applySessionExpiration(database,rpc(result))).toThrow(/session/);
  for(const expiration_date of [false,'in 3 days','10/11/2026','2026-02-30 14:00:00']) expect(applySessionExpiration(database,rpc({uid:2,db:'fixture',expiration_date})).expiresAt).toBeNull();
 });
 it('preserves missing dates and refuses conflicting sources',()=>{
  const database=parseDatabaseList(rpc({databases:[{...row,expiration_date:'2026-10-22'}]}))[0].database;
  expect(applySessionExpiration(database,rpc({uid:2,db:'fixture'})).expiresAt).toBe('2026-10-22');
  expect(applySessionExpiration(database,rpc({uid:2,db:'fixture',expiration_date:'2026-10-23'})).expiresAt).toBeNull();
 });
 it('requires exact supported origins',()=>{
  for(const input of ['http://fixture.odoo.com','https://fixture.odoo.com:444','https://www.odoo.com','https://name:secret@fixture.odoo.com','https://fixture.odoo.com.evil.test']) expect(databaseOrigin(input)).toBeNull();
 });
});

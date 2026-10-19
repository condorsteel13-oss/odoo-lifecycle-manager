import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {SessionVault,type SessionCipher} from '../electron/session-vault';
import {LocalStore} from '../electron/store';
const key=randomBytes(32);
const cipher:SessionCipher={available:()=>true,encrypt(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(value),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},decrypt(value){const c=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(12,28));return Buffer.concat([c.update(value.subarray(28)),c.final()]).toString();}};
const cookie={name:'session_id',value:'secret-session-token',domain:'.odoo.com',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'};
describe('private persistent sessions',()=>{
 it('encrypts session-only Odoo cookies, scopes them and restores them after restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lifecycle-session-'));
  try{
   const vault=new SessionVault(dir,'odoo',cipher);
   await vault.saveOdoo({cookies:async()=>[cookie,{...cookie,domain:'.example.com'},{...cookie,domain:'odoo.com.evil.test'},{...cookie,domain:'old.odoo.com',expires:1}]} as any);
   const bytes=await readFile(vault.path);expect(bytes.toString()).not.toContain(cookie.value);expect((await stat(vault.path)).mode&0o777).toBe(0o600);
   let restored:any[]=[];await new SessionVault(dir,'odoo',cipher).restoreOdoo({addCookies:async(c:any[])=>{restored=c;}} as any);
   expect(restored).toEqual([cookie]);await vault.clear();expect(await new SessionVault(dir,'odoo',cipher).restoreMail()).toBeNull();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('refuses unavailable encryption and does not fall back to plaintext',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lifecycle-session-'));
  try{const vault=new SessionVault(dir,'mail',{...cipher,available:()=>false});await expect(vault.saveMail({email:'user@example.com',accessToken:'secret',refreshToken:'refresh'})).rejects.toThrow(/secure storage/);await expect(readFile(vault.path)).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}
 });
 it('rejects corruption and a decrypted session from the wrong provider',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lifecycle-session-'));
  try{const vault=new SessionVault(dir,'mail',cipher);await vault.saveMail({email:'user@example.com',accessToken:'secret',refreshToken:'refresh'});await expect(new SessionVault(dir,'odoo',cipher).restoreOdoo({} as any)).rejects.toThrow(/unlocked/);await writeFile(vault.path,'broken');await expect(vault.restoreMail()).rejects.toThrow(/unlocked/);}finally{await rm(dir,{recursive:true,force:true});}
 });
 it('migrates old settings without losing history or enabling reconnect or monitoring',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lifecycle-migration-'));
  try{const store=new LocalStore(dir);const {data}=await store.load();const old:any={...data};delete old.browserPreferences;delete old.savedConnections;await writeFile(store.path,JSON.stringify(old));const loaded=await store.load();expect(loaded.recovered).toBe(false);expect(loaded.data).toMatchObject({browserPreferences:{headless:true},savedConnections:{odoo:false,mail:false},settings:{monitoringEnabled:false},liveHistory:[],liveSafetyLock:false});}finally{await rm(dir,{recursive:true,force:true});}
 });
});

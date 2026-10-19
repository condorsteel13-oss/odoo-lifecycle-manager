import {it,expect,vi} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AppService,type MailConnection} from '../electron/service';
import {LocalStore} from '../electron/store';
import {demoDiscovery} from '../src/domain/demo';
import {AppError} from '../electron/errors';
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'lifecycle-connections-'));const store=new LocalStore(join(dir,'data'));
 const discovery={...demoDiscovery(),source:'odoo' as const};
 const browser={connect:vi.fn(async()=>discovery),refresh:vi.fn(async()=>discovery),check:vi.fn(async()=>{}),applyMode:vi.fn(async()=>{}),setHeadless:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
 const mail:MailConnection={connect:vi.fn(async()=>'user@example.com'),finishLogin:vi.fn(),check:vi.fn(async()=>'user@example.com'),setHeadless:vi.fn(async()=>{}),close:vi.fn(async()=>{}),findActivationLink:vi.fn()};
 const make=()=>new AppService(store,join(dir,'profile'),'unused',()=>{},browser,async()=>false,{mailbox:mail});
 let service=make();await service.initialize();return {store,browser,mail,get service(){return service;},restart:async()=>{await service.dispose();service=make();await service.initialize();},cleanup:async()=>{await service.dispose();await rm(dir,{recursive:true,force:true});}};
}
it('starts disconnected, restores both verified connections after restart without manual login',async()=>{
 const f=await fixture();try{
  expect(f.service.getState()).toMatchObject({mailConnection:{status:'disconnected'},browserPreferences:{headless:true}});
  await f.service.connect();await f.service.connectMail();await f.restart();
  expect(f.service.getState().connection).toBe('disconnected');expect(f.service.getState().mailConnection.status).toBe('disconnected');
  await f.service.restoreConnections();expect(f.service.getState()).toMatchObject({connection:'connected',mailConnection:{status:'connected',email:'user@example.com'}});
  expect(f.browser.connect).toHaveBeenCalledTimes(1);expect(f.mail.connect).toHaveBeenCalledTimes(1);expect(f.browser.check).toHaveBeenCalledTimes(1);
  expect(await readFile(f.store.path,'utf8')).not.toMatch(/accessToken|refreshToken|password/);
 }finally{await f.cleanup();}
});
it('reports independent authentication failures and preserves cached data',async()=>{
 const f=await fixture();try{
  await f.service.connect();await f.service.connectMail();const before=f.service.getState().discovery;
  vi.mocked(f.mail.check).mockRejectedValue(new AppError('MAIL_SESSION_EXPIRED','Reconnect Viamail.'));
  await f.service.checkConnections();expect(f.service.getState()).toMatchObject({connection:'connected',mailConnection:{status:'expired'},discovery:before});
  vi.mocked(f.mail.check).mockResolvedValue('user@example.com');f.browser.check.mockRejectedValue(new AppError('SESSION_EXPIRED','Reconnect Odoo.'));
  await f.service.checkConnections();expect(f.service.getState()).toMatchObject({connection:'expired',mailConnection:{status:'connected'}});
 }finally{await f.cleanup();}
});
it('switches display mode using saved sessions and pauses restore when closed',async()=>{
 const f=await fixture();try{
  await f.service.connect();await f.service.connectMail();await f.service.saveBrowserPreferences({headless:false});
  expect(f.browser.setHeadless).toHaveBeenLastCalledWith(false);expect(f.mail.setHeadless).toHaveBeenLastCalledWith(false);expect(f.browser.connect).toHaveBeenCalledTimes(1);expect(f.mail.connect).toHaveBeenCalledTimes(1);
  await f.service.disconnect();await f.restart();const checks=f.browser.check.mock.calls.length;await f.service.restoreConnections();expect(f.browser.check).toHaveBeenCalledTimes(checks);
  expect(f.service.getState()).toMatchObject({browserPreferences:{headless:false},savedConnections:{odoo:false,mail:false},settings:{monitoringEnabled:false}});
  await expect(f.service.saveBrowserPreferences({headless:true,liveExecution:true} as any)).rejects.toThrow(/visible or headless/);
 }finally{await f.cleanup();}
});

it('retains a verified visible login when the server rejects the headless handoff',async()=>{
 const f=await fixture();try{
  f.browser.applyMode.mockRejectedValue(new AppError('HEADLESS_BLOCKED','Odoo rejected headless access. Use visible Chrome.'));
  await expect(f.service.connect()).rejects.toThrow(/headless/);
  expect(f.service.getState()).toMatchObject({connection:'blocked',savedConnections:{odoo:true},discovery:{source:'odoo'}});
  await f.service.saveBrowserPreferences({headless:false});expect(f.service.getState().connection).toBe('connected');expect(f.browser.connect).toHaveBeenCalledTimes(1);
 }finally{await f.cleanup();}
});

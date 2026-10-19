import {describe,it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>{
 const chrome={launch:vi.fn(),close:vi.fn(),isRunning:true};
 const reader={install:vi.fn(),list:vi.fn(),session:vi.fn(),manage:vi.fn(),authenticate:vi.fn(),allowDatabases:vi.fn(),assertSafe:vi.fn()};
 const idle={setContent:vi.fn()};
 const context={newPage:vi.fn(()=>idle)};
 const browser={contexts:()=>[context],isConnected:()=>true,close:vi.fn()};
 return {chrome,reader,browser,connect:vi.fn(()=>browser)};
});
vi.mock('../electron/chrome-login',()=>({ManualChrome:class {constructor(){return mocks.chrome;}}}));
vi.mock('../electron/background-pages',()=>({enableBackgroundPages:vi.fn(),BackgroundPages:{create:vi.fn(async()=>({newPage:vi.fn()}))}}));
vi.mock('../electron/reader',()=>({MetadataReader:class {constructor(){return mocks.reader;}}}));
vi.mock('playwright',()=>({chromium:{connectOverCDP:mocks.connect}}));
import {ReadOnlyBrowser} from '../electron/browser';
import {AppError} from '../electron/errors';
const row={db_name:'fixture',uuid:'11111111-1111-1111-1111-111111111111',url:'https://fixture.odoo.com',version:'19.0',is_trial:true};
const rpc=(result:unknown)=>({jsonrpc:'2.0',id:1,result});
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.chrome.launch.mockResolvedValue('http://127.0.0.1:12345');
 mocks.browser.close.mockResolvedValue(undefined);
 mocks.reader.list.mockResolvedValue(rpc({databases:[row]}));
 mocks.reader.session.mockResolvedValue(rpc({uid:1,db:'fixture'}));
 mocks.reader.manage.mockImplementation(async database=>({...database,expiresAt:null,remainingDays:31,expirationObservedAt:'2026-10-19T17:00:00Z'}));
});
describe('manual Chrome handoff and session lifetime',()=>{
 it('leaves accounting alone during discovery',async()=>{
  mocks.reader.list.mockResolvedValue(rpc({databases:[{...row,db_name:'example-accounting-0805',url:'https://example-accounting-0805.odoo.com'}]}));
  const connection=new ReadOnlyBrowser('/fixture','',()=>{});const result=await connection.refresh();
  expect(result.databases[0].expirationEvidence).toMatch(/Excluded/);expect(mocks.reader.session).not.toHaveBeenCalled();expect(mocks.reader.manage).not.toHaveBeenCalled();expect(mocks.reader.authenticate).not.toHaveBeenCalled();await connection.close();
 });
 it('does not attach before handoff and preserves the guarded session across refreshes',async()=>{
  const connection=new ReadOnlyBrowser('/fixture','',()=>{});
  const pending=connection.connect();
  await vi.waitFor(()=>expect(mocks.chrome.launch).toHaveBeenCalledOnce());
  expect(mocks.connect).not.toHaveBeenCalled();
  connection.finishLogin();
  expect((await pending).databases[0].remainingDays).toBe(31);
  const closes=mocks.chrome.close.mock.calls.length;
  await connection.refresh();
  expect(mocks.chrome.launch).toHaveBeenCalledOnce();
  expect(mocks.connect).toHaveBeenCalledOnce();
  expect(mocks.chrome.close).toHaveBeenCalledTimes(closes);
  await connection.close();
  expect(mocks.chrome.close).toHaveBeenCalledTimes(closes+1);
 });
 it('authenticates only a missing database session and retries the fixed reader',async()=>{
  mocks.reader.session.mockRejectedValueOnce(new AppError('SESSION_EXPIRED','Session required'));
  const connection=new ReadOnlyBrowser('/fixture','',()=>{});
  expect((await connection.refresh()).databases[0].remainingDays).toBe(31);
  expect(mocks.reader.authenticate).toHaveBeenCalledWith(row.url,row.uuid,row.db_name);
  await connection.close();
 });
 it('does not treat a server failure as permission to authenticate again',async()=>{
  mocks.reader.manage.mockRejectedValueOnce(new Error('PRIVATE'));
  const connection=new ReadOnlyBrowser('/fixture','',()=>{});
  const result=await connection.refresh();
  expect(result.databases[0].expiresAt).toBeNull();
  expect(mocks.reader.authenticate).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  await connection.close();
 });
 it('cancelling during Chrome startup prevents a later attachment',async()=>{
  let launch!: (endpoint:string)=>void;
  mocks.chrome.launch.mockImplementationOnce(()=>new Promise(resolve=>{launch=resolve;}));
  const connection=new ReadOnlyBrowser('/fixture','',()=>{});
  const pending=connection.connect();
  const rejection=expect(pending).rejects.toThrow(/cancelled/);
  await vi.waitFor(()=>expect(launch).toBeTypeOf('function'));
  await connection.close();launch('http://127.0.0.1:12345');await rejection;
  expect(mocks.connect).not.toHaveBeenCalled();
 });
});
it('manual login stays visible, then saves and restores into windowless Chrome without another login',async()=>{
 const vault={saveOdoo:vi.fn(async()=>{}),restoreOdoo:vi.fn(async()=>{})};
 const connection=new ReadOnlyBrowser('/fixture','',()=>{},vault as any);
 await connection.setHeadless(true);const pending=connection.connect();
 await vi.waitFor(()=>expect(mocks.chrome.launch).toHaveBeenCalled());
 expect(mocks.chrome.launch.mock.calls[0]).toHaveLength(1);expect(mocks.connect).not.toHaveBeenCalled();
 connection.finishLogin();await pending;await connection.applyMode();
 expect(vault.saveOdoo).toHaveBeenCalled();expect(vault.restoreOdoo).toHaveBeenCalledOnce();
 expect(mocks.chrome.launch).toHaveBeenLastCalledWith('about:blank','background');
 await connection.setHeadless(false);await connection.check();
 expect(mocks.chrome.launch).toHaveBeenLastCalledWith('about:blank',false);await connection.close();
});
it('a stalled saved-session check times out and closes only the owned browser',async()=>{
 vi.useFakeTimers();
 const connection=new ReadOnlyBrowser('/fixture','',()=>{});
 try{
  mocks.reader.list.mockImplementationOnce(()=>new Promise(()=>{}));
  const pending=expect(connection.check()).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(60001);await pending;
  expect(mocks.chrome.close).toHaveBeenCalled();
 }finally{vi.useRealTimers();await connection.close();}
});

it('headless rejection preserves the successful login and points to visible mode',async()=>{
 const vault={saveOdoo:vi.fn(async()=>{}),restoreOdoo:vi.fn(async()=>{})};const connection=new ReadOnlyBrowser('/fixture','',()=>{},vault as any);await connection.setHeadless(true);
 const pending=connection.connect();await vi.waitFor(()=>expect(mocks.chrome.launch).toHaveBeenCalled());connection.finishLogin();await pending;
 mocks.reader.list.mockRejectedValueOnce(new AppError('SESSION_EXPIRED','Odoo could not complete the metadata read (HTTP 403).'));
 await expect(connection.applyMode()).rejects.toMatchObject({code:'HEADLESS_BLOCKED'});expect(vault.saveOdoo).toHaveBeenCalled();
 await connection.setHeadless(false);await connection.check();expect(mocks.chrome.launch).toHaveBeenLastCalledWith('about:blank',false);await connection.close();
});

import {it,expect,vi} from 'vitest';
import {BackgroundPages} from '../electron/background-pages';
function fixture({type='other',hasWindow=false,rejectCreate=false}={}){
 const pageSession={send:vi.fn(async()=>({targetInfo:{targetId:'owned',type}})),detach:vi.fn(async()=>{})};
 const page={};const context={waitForEvent:vi.fn(async()=>page),newCDPSession:vi.fn(async()=>pageSession),newPage:vi.fn()};
 const session={send:vi.fn(async(method:string)=>{
  if(method==='Target.createTarget'){if(rejectCreate)throw new Error('unsupported');return {targetId:'owned'};}
  if(method==='Browser.getWindowForTarget'){if(!hasWindow)throw new Error('No window');return {windowId:1};}
  return {};
 })};
 const browser={newBrowserCDPSession:vi.fn(async()=>session)};
 return {context,session,browser,page};
}
it('creates only a hidden empty target and verifies its identity and absence of a window',async()=>{
 const f=fixture();const pages=await BackgroundPages.create(f.browser as any,f.context as any);
 expect(await pages.newPage()).toBe(f.page);
 expect(f.session.send).toHaveBeenCalledWith('Target.createTarget',{url:'about:blank',hidden:true,background:true});
 expect(f.context.newPage).not.toHaveBeenCalled();
});
it.each([{type:'page'},{hasWindow:true},{rejectCreate:true}])('unsupported hidden pages fail closed without a visible-page fallback: %j',async options=>{
 const f=fixture(options);const pages=await BackgroundPages.create(f.browser as any,f.context as any);
 await expect(pages.newPage()).rejects.toMatchObject({code:'BACKGROUND_UNAVAILABLE'});
 expect(f.context.newPage).not.toHaveBeenCalled();
 if(!options.rejectCreate)expect(f.session.send).toHaveBeenCalledWith('Target.closeTarget',{targetId:'owned'});
});

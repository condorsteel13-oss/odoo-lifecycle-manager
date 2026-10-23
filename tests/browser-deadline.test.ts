import {afterEach,expect,it,vi} from 'vitest';
import type {Page} from 'playwright';
import {readerDeadline,closeReaderPage} from '../electron/browser-deadline';
afterEach(()=>vi.useRealTimers());
it('enforces an app-side deadline even when the renderer never answers or finishes closing',async()=>{
 vi.useFakeTimers();const close=vi.fn(()=>new Promise<void>(()=>{})),page={close} as unknown as Page;
 const result=readerDeadline(page,()=>new Promise(()=>{}),100,'BROWSER_REQUEST_TIMEOUT','Reader stalled');
 const rejected=expect(result).rejects.toMatchObject({code:'BROWSER_REQUEST_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(100);await rejected;expect(close).toHaveBeenCalledOnce();
});
it('prevents a late setup from submitting its request after the deadline',async()=>{
 vi.useFakeTimers();let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;});
 const submit=vi.fn(),page={close:vi.fn(async()=>{})} as unknown as Page;
 const result=readerDeadline(page,async check=>{await gate;check();submit();},100,'BROWSER_REQUEST_TIMEOUT','Reader stalled');
 const rejected=expect(result).rejects.toThrow('Reader stalled');await vi.advanceTimersByTimeAsync(100);await rejected;
 resume();await vi.advanceTimersByTimeAsync(1);expect(submit).not.toHaveBeenCalled();
});
it('does not retry work or leave a deadline running after completion',async()=>{
 vi.useFakeTimers();const close=vi.fn(async()=>{}),work=vi.fn(async()=>42),page={close} as unknown as Page;
 await expect(readerDeadline(page,work,100,'TIMEOUT','Reader stalled')).resolves.toBe(42);
 await vi.advanceTimersByTimeAsync(200);expect(work).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
});
it('bounds cleanup when a browser cannot acknowledge closing an owned reader',async()=>{
 vi.useFakeTimers();const page={close:vi.fn(()=>new Promise<void>(()=>{}))} as unknown as Page;
 const result=closeReaderPage(page);await vi.advanceTimersByTimeAsync(2000);await result;
});

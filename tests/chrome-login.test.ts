import { afterEach, expect, it, vi } from 'vitest';
import { ManualChrome } from '../electron/chrome-login';

afterEach(()=>vi.unstubAllGlobals());

it('keeps a handed-off Chrome login alive while its private DevTools endpoint responds',async()=>{
  const port='43123';
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/browser/test`}))));
  const chrome=new ManualChrome('/tmp/unused-chrome-profile') as any;
  chrome.process={exitCode:0,signalCode:null};
  chrome.endpoint=`http://127.0.0.1:${port}`;

  expect(chrome.isRunning).toBe(false);
  expect(await chrome.isAvailable()).toBe(true);
  expect(chrome.isRunning).toBe(true);
});

it('marks the app-owned Chrome session unavailable after its endpoint closes',async()=>{
  const port='43124';
  const fetch=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/browser/test`})))
    .mockRejectedValueOnce(new Error('connection refused'));
  vi.stubGlobal('fetch',fetch);
  const chrome=new ManualChrome('/tmp/unused-chrome-profile') as any;
  chrome.process={exitCode:0,signalCode:null};
  chrome.endpoint=`http://127.0.0.1:${port}`;
  expect(await chrome.isAvailable()).toBe(true);
  expect(await chrome.isAvailable()).toBe(false);
  expect(chrome.isRunning).toBe(false);
});

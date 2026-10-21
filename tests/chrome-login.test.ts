import { afterEach, expect, it, vi } from 'vitest';
import { ManualChrome, waitForChromeEndpoint } from '../electron/chrome-login';

afterEach(()=>vi.unstubAllGlobals());

it('waits for the Chrome endpoint after the launcher handoff',async()=>{
  const port='43122';
  const fetch=vi.fn()
    .mockRejectedValueOnce(new Error('endpoint not ready yet'))
    .mockResolvedValueOnce(new Response(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/browser/test`})));
  vi.stubGlobal('fetch',fetch);
  await expect(waitForChromeEndpoint(`http://127.0.0.1:${port}`,port,3,0)).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects a Chrome endpoint outside its app-owned loopback port',async()=>{
  const port='43121';
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({webSocketDebuggerUrl:'ws://example.com:43121/devtools/browser/test'}))));
  await expect(waitForChromeEndpoint(`http://127.0.0.1:${port}`,port,1,0)).resolves.toBe(false);
});

it('does not close a Chrome session whose endpoint was never confirmed ready',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const chrome=new ManualChrome('/tmp/unused-chrome-profile') as any;
  chrome.process={exitCode:0,signalCode:null};
  chrome.endpoint='http://127.0.0.1:43120';
  await chrome.close();
  expect(fetch).not.toHaveBeenCalled();
  expect(chrome.endpoint).toBeNull();
});

import { test, expect, chromium, type Browser } from '@playwright/test';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect, createServer as portServer } from 'node:net';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {MailReader,captureRememberedMailSession,captureMailSession} from '../../electron/mail-reader';
import {scopedActivationMessage} from '../../electron/mailbox';
import { readActivationMessage } from '../../electron/mailbox';
import { MetadataReader, LIST_PATH, SESSION_PATH, INFO_PATH } from '../../electron/reader';
import {BackgroundPages,enableBackgroundPages} from '../../electron/background-pages';
let browser: Browser;
let backgroundBrowser: Browser;
let backgroundLauncher: ChildProcess;
let server: ReturnType<typeof httpsServer>;
let proxy: ReturnType<typeof httpServer>;
let directory: string;
let received: string[] = [];
let redirectRead = false;
let formLogin = false;
let manageLogin = false;
let liveMode = false;
let liveRedirect = false;
let portalFailure = false;
let activationRecipient='previous@example.com';
let mailboxMode='ok';
let mailBodies:any[]=[];
const mailToken=(email='user@example.com',exp=Math.floor(Date.now()/1000)+3600)=>'fixture.'+Buffer.from(JSON.stringify({nameid:email,exp})).toString('base64url')+'.fixture';
const mailRow=()=>({uid:5,folder:'inbox',from:{email:'online@odoo.com'},recipients:[{email:'user@example.com'}],subject:'Activate fixture-copy',internalDate:new Date().toISOString()});
let liveBodies: {path:string;params:unknown}[] = [];
const uuid='11111111-1111-1111-1111-111111111111';
const manageHTML='<html><body><div class="alert alert-danger">Your trial will expire in <strong>31</strong> day(s)</div><h3 id="database-section">Database</h3><p>Your database runs on fixture.odoo.com</p><button>Delete</button><script>fetch("/my/databases/delete",{method:"POST"})</script></body></html>';

let authDestination = 'https://fixture.odoo.com/auth_oauth/oea?db=fixture&access_token=local-fixture-token';
test.beforeAll(async () => {
  enableBackgroundPages();
  directory = mkdtempSync(join(tmpdir(), 'odoo-guard-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=www.odoo.com'], { stdio: 'ignore' });
  server = httpsServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) }, (req, res) => {
    received.push(`${req.method} ${req.url}`);
    if(req.headers.host==='mail.viamtl.com'){
      if(req.url==='/api/v1/settings/user-mail'){
        if(mailboxMode==='redirect'){res.writeHead(302,{location:'/api/v1/mail/delete-messages'});res.end();return;}
        res.writeHead(mailboxMode==='expired'?401:200,{'content-type':'application/json'});res.end(JSON.stringify(mailboxMode==='expired'?{success:false}:{userMailSettings:{}}));return;
      }
      if(req.url==='/api/v1/auth/refresh-token'){
        let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
          mailBodies.push({path:req.url,params:JSON.parse(body)});
          res.writeHead(mailboxMode==='expired'?401:200,{'content-type':'application/json'});res.end(JSON.stringify(mailboxMode==='expired'?{success:false}:{accessToken:mailToken(mailboxMode==='refresh-wrong-user'?'other@example.com':'user@example.com'),refreshToken:'rotated-fixture-refresh'}));
        });return;
      }
      if(req.url==='/interface/root'){res.writeHead(200,{'content-type':'text/html'});res.end(`<body><script>window.angular={element:()=>({injector:()=>({get:n=>n==='claimsService'?{getEmailAddress:()=>('${mailboxMode==='wrong-user'?'other@example.com':'user@example.com'}'),impersonating:()=>false}:{getToken:()=>('${mailToken()}'),getRefreshToken:()=>('fixture-refresh')}})})};</script></body>`);return;}
      if(['/api/v1/mail/messages','/api/v1/mail/message'].includes(req.url??'')){let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{mailBodies.push({path:req.url,params:JSON.parse(body)});if(mailboxMode==='redirect'){res.writeHead(302,{location:'/api/v1/mail/delete-messages'});res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url==='/api/v1/mail/messages'?{results:mailboxMode==='no-match'?[{...mailRow(),subject:'Unrelated'}]:[mailRow()]}:{messageData:{...mailRow(),messageHTML:'<p>fixture-copy</p><a href="https://fixture-copy.odoo.com/saas_trial/confirm/1234567890123456">Activate</a><script>fetch("/api/v1/mail/delete-messages")</script><img src="https://tracker.example/x">'}}));});return;}
    }
    if(req.url?.startsWith('/odoo-enterprise/confirm-database/fixture/')){res.writeHead(303,{location:'https://fixture.odoo.com/odoo'});res.end();return;}
    if(req.url==='/saas_worker/trial_info'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{status:'to_activate',user_email:'current@example.com',activation_email:activationRecipient}}));return;}
    if(req.url==='/saas_worker/send_activation_email'){let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{liveBodies.push({path:req.url!,params:JSON.parse(body).params});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{success:'Activation email sent'}}));});return;}
    if(liveMode && ['/odoo-enterprise/trial-check','/saas_worker/dup/json','/my/databases/delete','/saas_worker/drop/json'].includes(req.url??'')) {
      let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
        liveBodies.push({path:req.url!,params:JSON.parse(body).params});
        if(liveRedirect){res.writeHead(302,{location:'https://www.odoo.com/odoo-enterprise/delete-database'});res.end();return;}
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:req.url==='/odoo-enterprise/trial-check'?{error:false}:req.url==='/saas_worker/dup/json'?{success:'https://fixture.odoo.com/progress'}:{result:!(portalFailure&&req.url==='/my/databases/delete')}}));
      });return;
    }
    if(req.url === '/my/databases/connect/'+uuid+'?manage_db=true') {
     if(formLogin){res.writeHead(200,{'content-type':'text/html'});res.end('<form action="https://fixture.odoo.com/saas_trial/trial-connect" method="POST"><input type="hidden" name="db_uuid" value="'+uuid+'"><input type="hidden" name="token" value="fixture-token"><input type="hidden" name="redirect" value="'+(manageLogin?'https://fixture.odoo.com/odoo/my-subscription':'https://fixture.odoo.com/auth_oauth/oea?db=fixture')+'"></form>');return;}
     res.writeHead(303,{location:authDestination});res.end();return;
    }
    if(req.url==='/saas_trial/trial-connect'){res.writeHead(303,{location:manageLogin?'https://fixture.odoo.com/odoo/my-subscription':authDestination});res.end();return;}
    if(req.url===INFO_PATH){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({result:'odt_fixture_token_123456'}));return;}
    if(req.url?.startsWith('/my/database?')){res.writeHead(200,{'content-type':'text/html'});res.end(manageHTML);return;}
    if(req.url?.startsWith('/auth_oauth/oea?')) {res.writeHead(303,{location:'/odoo','set-cookie':'db_session=fixture; Path=/; Secure; HttpOnly'});res.end();return;}
    if (req.url === LIST_PATH || req.url === SESSION_PATH) {
      if(redirectRead) {res.writeHead(302,{location:'/my/databases/delete'});res.end();return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:req.url === LIST_PATH ? {databases:[]} : {uid:1,db:'fixture',expiration_date:'2026-10-22 14:00:00'}}));return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const serverPort = (server.address() as { port: number }).port;
  proxy = httpServer((_req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connect', (req, socket, head) => {
    // No possible egress: only this fake hostname is mapped to the local fixture server.
    if (!['www.odoo.com:443','fixture.odoo.com:443','mail.viamtl.com:443'].includes(req.url ?? '')) { socket.destroy(); return; }
    const target = connect(serverPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); socket.pipe(target); target.pipe(socket); });
    socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy()); socket.on('close', () => target.destroy());
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const folder = readdirSync('browser-binaries').find(n => /^chromium-/.test(n))!;
  browser = await chromium.launch({ executablePath: resolve('browser-binaries', folder, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), headless: true, proxy: { server: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` } });
  // Exercise the production normal-Chrome hidden-target behavior. The same
  // loopback proxy prevents any request from reaching a real account.
  const debugPort=await new Promise<number>((resolve,reject)=>{const s=portServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=(s.address() as {port:number}).port;s.close(()=>resolve(p));});});
  backgroundLauncher = spawn(resolve('dist-electron/chrome-background'),[`--user-data-dir=${join(directory,'chrome')}`,`--remote-debugging-port=${debugPort}`,'--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--no-startup-window',`--proxy-server=http://127.0.0.1:${(proxy.address() as {port:number}).port}`],{stdio:['ignore','pipe','ignore']});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Hidden launch timed out')),10000);backgroundLauncher.stdout!.once('data',data=>{clearTimeout(timer);String(data).includes('ready')?resolve():reject(new Error('Unexpected launcher response'));});backgroundLauncher.once('error',reject);});
  await expect.poll(async()=>{try{return(await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;}catch{return false;}}).toBe(true);
  backgroundBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
});
test.afterAll(async () => { if(backgroundLauncher&&backgroundLauncher.exitCode===null&&backgroundLauncher.signalCode===null){backgroundLauncher.kill('SIGTERM');await new Promise<void>(resolve=>{const t=setTimeout(()=>{backgroundLauncher.kill('SIGKILL');resolve();},5000);backgroundLauncher.once('exit',()=>{clearTimeout(t);resolve();});});} await backgroundBrowser?.close().catch(()=>{}); await browser?.close(); server?.closeAllConnections(); server?.close(); proxy?.closeAllConnections(); proxy?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
test.beforeEach(() => { mailboxMode='ok';mailBodies=[];activationRecipient='previous@example.com'; redirectRead = false; formLogin=false; manageLogin=false; liveMode=false;liveRedirect=false;portalFailure=false;liveBodies=[];received = []; authDestination = 'https://fixture.odoo.com/auth_oauth/oea?db=fixture&access_token=local-fixture-token'; });

test('native metadata reads use only fixed routes and no document reaches the server',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);
 expect(await reader.list()).toMatchObject({result:{databases:[]}});
 expect(await reader.session('https://fixture.odoo.com')).toMatchObject({result:{expiration_date:'2026-10-22 14:00:00'}});
 expect(received).toEqual(['POST '+LIST_PATH,'POST '+SESSION_PATH]);
 await expect(reader.session('https://other.odoo.com')).rejects.toThrow(/fixed/);
 await context.close();
});
async function hiddenFixture(){
 const context=await backgroundBrowser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const cdp=await backgroundBrowser.newBrowserCDPSession();
 const {browserContextIds}=await cdp.send('Target.getBrowserContexts');await cdp.detach();
 expect(browserContextIds).toHaveLength(1);expect(context.pages()).toHaveLength(0);
 const pages=await BackgroundPages.create(backgroundBrowser,context,browserContextIds[0]);
 const reader=new MetadataReader(context,()=>pages.newPage());await reader.install(()=>pages.keepAlive());reader.allowDatabases(['https://fixture.odoo.com']);
 return {context,pages,reader};
}
test('hidden reader targets have no window, retain the guards, and close after each read',async()=>{
 const {context,reader}=await hiddenFixture();
 expect(await reader.list()).toMatchObject({result:{databases:[]}});
 expect(await reader.session('https://fixture.odoo.com')).toMatchObject({result:{uid:1}});
 expect(received).toEqual(['POST '+LIST_PATH,'POST '+SESSION_PATH]);expect(context.pages()).toHaveLength(1);
 await reader.authenticate('https://fixture.odoo.com',uuid,'fixture');
 expect((await context.cookies('https://fixture.odoo.com')).some(c=>c.name==='db_session')).toBe(true);
 const result=await reader.manage(liveTarget().database,uuid);expect(result.remainingDays).toBe(31);
 expect(received.some(url=>/delete|drop|dup\/json|send_activation|trial_info/.test(url))).toBe(false);
 expect(context.pages()).toHaveLength(1);await context.close();
});
test('hidden reader refuses redirects and untrusted requests without opening visible tabs',async()=>{
 const {context,pages,reader}=await hiddenFixture();redirectRead=true;
 await expect(reader.list()).rejects.toThrow(/metadata/);expect(received).toEqual(['POST '+LIST_PATH]);
 const page=await pages.newPage();await page.goto('https://www.odoo.com/my/databases/delete').catch(()=>{});
 expect(received).toEqual(['POST '+LIST_PATH]);await page.close();expect(context.pages()).toHaveLength(1);await context.close();
});
test('a server redirect toward a mutation is never followed by native fetch',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const reader=new MetadataReader(context);await reader.install();redirectRead=true;
 await expect(reader.list()).rejects.toThrow(/metadata/);
 expect(received).toEqual(['POST '+LIST_PATH]);
 await context.close();
});
test('untrusted pages cannot invoke database operations through the reader context',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const reader=new MetadataReader(context);await reader.install();
 const page=await context.newPage();
 await page.goto('https://www.odoo.com/my/databases/delete').catch(()=>{});
 expect(received).toEqual([]);
 await context.close();
});
test('official database sign-in follows only the validated OEA handoff and never loads the application',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);
 await reader.authenticate('https://fixture.odoo.com','11111111-1111-1111-1111-111111111111','fixture');
 expect(received).toEqual(['GET /my/databases/connect/11111111-1111-1111-1111-111111111111?manage_db=true','GET /auth_oauth/oea?db=fixture&access_token=local-fixture-token']);
 expect((await context.cookies('https://fixture.odoo.com')).some(c=>c.name==='db_session')).toBe(true);
 await context.close();
});
test('sign-in rejects unexpected redirect hosts, mutations, signup and conflicting identities',async()=>{
 for(const destination of ['https://evil.example/auth_oauth/oea?db=fixture&access_token=secret','https://fixture.odoo.com/my/databases/delete','https://fixture.odoo.com/auth_oauth/signin?access_token=secret','https://fixture.odoo.com/auth_oauth/oea?db=other&access_token=secret','https://fixture.odoo.com/auth_oauth/oea?db=fixture&db=other&access_token=secret']) {
  const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
  const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);
  received=[];authDestination=destination;
  await expect(reader.authenticate('https://fixture.odoo.com','11111111-1111-1111-1111-111111111111','fixture')).rejects.toThrow(/unsupported/);
  expect(received).toEqual(['GET /my/databases/connect/11111111-1111-1111-1111-111111111111?manage_db=true']);
  await context.close();
 }
});

test('Manage HTML is read without executing its management scripts or loading the database app',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);
 const database={id:'https://fixture.odoo.com',name:'fixture',url:'https://fixture.odoo.com'} as import('../../src/shared/types').Database;
 const result=await reader.manage(database,uuid);
 expect(result.remainingDays).toBe(31);expect(result.expiresAt).toBeNull();
 expect(received).toEqual(['POST '+INFO_PATH,'GET /my/database?lang=en_US&token=odt_fixture_token_123456']);
 expect(JSON.stringify(result)).not.toContain('odt_');
 await context.close();
});
test('the official Connect form is submitted only to trial-connect and application redirect is ignored',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);formLogin=true;
 await reader.authenticate('https://fixture.odoo.com',uuid,'fixture');
 expect(received).toEqual(['GET /my/databases/connect/'+uuid+'?manage_db=true','POST /saas_trial/trial-connect','GET /auth_oauth/oea?db=fixture&access_token=local-fixture-token']);
 await context.close();
});

test('observed Manage sign-in form stops before the management application',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);formLogin=true;manageLogin=true;
 await reader.authenticate('https://fixture.odoo.com',uuid,'fixture');
 expect(received).toEqual(['GET /my/databases/connect/'+uuid+'?manage_db=true','POST /saas_trial/trial-connect']);
 await context.close();
});

const liveTarget=()=>({database:{id:'https://fixture.odoo.com',url:'https://fixture.odoo.com',name:'fixture'},uuid,parentUuid:null,neutralized:true,token:'fixture-private-token',accessToken:false,subId:false,isPaid:false,plan:'Trial'}) as import('../../electron/live-contract').LiveInspection;
test('name availability check sends no mutation and accepts only a valid name',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();liveMode=true;
 await reader.checkCopyName('fixture-copy','fixture');expect(received).toEqual(['POST /odoo-enterprise/trial-check']);expect(liveBodies[0].params).toEqual({dbname:'fixture-copy'});
 await expect(reader.checkCopyName('example-accounting-0805','fixture')).rejects.toThrow();expect(received).toHaveLength(1);await context.close();
});
test('live duplication has one exact testing-only request and never follows its success URL',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);liveMode=true;
 await reader.duplicateLive(liveTarget(),'fixture-copy');
 expect(received).toEqual(['POST /saas_worker/dup/json']);expect(liveBodies[0].params).toEqual({to:'fixture-copy',oauth_token:'fixture-private-token',stay_on_portal:false,test:true,support:false});
 await context.close();
});
test('live deletion performs only the two reviewed steps with exact identity',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);liveMode=true;
 await reader.deleteLive(liveTarget());
 expect(received).toEqual(['POST /my/databases/delete','POST /saas_worker/drop/json']);
 expect(liveBodies.map(r=>r.params)).toEqual([{token:'fixture-private-token',access_token:false,is_paid:false},{oauth_token:'fixture-private-token',db_name:'fixture',db_uuid:uuid}]);
 await context.close();
});
test('failed portal deletion never submits a database drop',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);liveMode=true;portalFailure=true;
 await expect(reader.deleteLive(liveTarget())).rejects.toThrow(/first deletion step/);expect(received).toEqual(['POST /my/databases/delete']);await context.close();
});
test('mutation redirects fail closed without retrying or following the redirect',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);liveMode=true;liveRedirect=true;
 await expect(reader.duplicateLive(liveTarget(),'fixture-copy')).rejects.toThrow(/not confirm/);expect(received).toEqual(['POST /saas_worker/dup/json']);await context.close();
});
test('untrusted pages and protected identities cannot use the live endpoints',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();liveMode=true;
 const page=await context.newPage();await page.goto('https://fixture.odoo.com/saas_worker/drop/json').catch(()=>{});
 await expect(reader.duplicateLive({...liveTarget(),database:{...liveTarget().database,name:'example-accounting-0805'}},'fixture-copy')).rejects.toThrow(/accounting/);
 expect(received).toEqual([]);await context.close();
});

test('activation resend uses the authenticated user, fixed route and exact body',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);
 await reader.sendActivation(liveTarget(),'current@example.com');
 expect(received).toEqual(['POST /saas_worker/trial_info','POST /saas_worker/send_activation_email']);
 expect(liveBodies).toEqual([{path:'/saas_worker/send_activation_email',params:{activation_email:'current@example.com'}}]);await context.close();
});
test('activation reads never send and already-matching recipients are not resent',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);activationRecipient='current@example.com';
 await reader.activation(liveTarget());await reader.sendActivation(liveTarget(),'current@example.com');
 expect(received).toEqual(['POST /saas_worker/trial_info','POST /saas_worker/trial_info']);expect(liveBodies).toEqual([]);await context.close();
});
test('activation cannot be redirected to a different email or accounting database',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);
 await expect(reader.sendActivation(liveTarget(),'arbitrary@example.com')).rejects.toThrow(/user changed/);
 await expect(reader.activation({...liveTarget(),database:{...liveTarget().database,name:'example-accounting-0805'}})).rejects.toThrow(/accounting/);
 expect(received).toEqual(['POST /saas_worker/trial_info']);expect(liveBodies).toEqual([]);await context.close();
});

test('mailbox reader uses only scoped read APIs and does not execute email HTML',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const page=await context.newPage();await page.goto('https://mail.viamtl.com/interface/root');
 const result=await readActivationMessage(page,{copyName:'fixture-copy',email:'user@example.com',createdAt:new Date(Date.now()-60000).toISOString()});
 expect(result).toBe('https://fixture-copy.odoo.com/saas_trial/confirm/1234567890123456');
 expect(mailBodies).toEqual([{path:'/api/v1/mail/messages',params:{folder:'inbox',ownerEmailAddress:'user@example.com',sortType:0,sortAscending:false,query:'fixture-copy',skip:0,take:20,selectedIds:[]}},{path:'/api/v1/mail/message',params:{Folder:'inbox',UID:5,OwnerEmailAddress:'user@example.com'}}]);
 expect(received.join(' ')).not.toMatch(/delete-messages|tracker|saas_trial/);await context.close();
});
for(const mode of ['wrong-user','no-match','redirect'])test(`mailbox ${mode} stops before message reading or activation`,async()=>{
 mailboxMode=mode;const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const page=await context.newPage();await page.goto('https://mail.viamtl.com/interface/root');
 await expect(readActivationMessage(page,{copyName:'fixture-copy',email:'user@example.com',createdAt:new Date(Date.now()-60000).toISOString()})).rejects.toThrow();
 expect(mailBodies.length).toBe(mode==='wrong-user'?0:1);expect(received.join(' ')).not.toMatch(/delete-messages|saas_trial/);await context.close();
});

test('email activation follows only its exact validated Odoo link and ignores redirects',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const reader=new MetadataReader(context);await reader.install();reader.allowDatabases(['https://fixture.odoo.com']);
 const link='https://www.odoo.com/odoo-enterprise/confirm-database/fixture/'+('x'.repeat(140))+'?username=current%40example.com&email=current%40example.com&country_id=38';
 await reader.activateFromEmail(liveTarget(),link);
 expect(received).toEqual(['POST /saas_worker/trial_info','GET '+new URL(link).pathname+new URL(link).search]);
 await expect(reader.activateFromEmail(liveTarget(),link+'&redirect=https://evil.example')).rejects.toThrow(/activation link/);expect(received).toHaveLength(3);await context.close();
});

test('headless Viamail check loads no mailbox page or messages and scoped activation remains read-only',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const saved:any[]=[];
 const reader=new MailReader(context,{email:'user@example.com',accessToken:mailToken(),refreshToken:'fixture-refresh'},async s=>{saved.push(s);});await reader.install();
 expect(await reader.check()).toBe('user@example.com');expect(received).toEqual(['GET /api/v1/settings/user-mail']);
 const target={copyName:'fixture-copy',email:'user@example.com',createdAt:new Date(Date.now()-60000).toISOString()};
 await scopedActivationMessage((path,body)=>reader.activationRead(path,body,target.email),target);
 expect(received).toEqual(['GET /api/v1/settings/user-mail','POST /api/v1/mail/messages','POST /api/v1/mail/message']);
 await expect(reader.activationRead('/api/v1/mail/messages',{ownerEmailAddress:'other@example.com'},'other@example.com')).rejects.toThrow(/does not match/);
 const page=await context.newPage();await page.goto('https://mail.viamtl.com/api/v1/mail/delete-messages').catch(()=>{});expect(received).toHaveLength(3);await context.close();
});
test('expired access tokens refresh once and save the rotated token before reads',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});let saved=false;
 const reader=new MailReader(context,{email:'user@example.com',accessToken:mailToken('user@example.com',1),refreshToken:'fixture-refresh'},async s=>{expect(s.refreshToken).toBe('rotated-fixture-refresh');saved=true;});await reader.install();
 expect(await reader.check()).toBe('user@example.com');expect(saved).toBe(true);
 expect(mailBodies).toEqual([{path:'/api/v1/auth/refresh-token',params:{token:'fixture-refresh',iswebmailrefresh:true}}]);expect(received).toEqual(['POST /api/v1/auth/refresh-token','GET /api/v1/settings/user-mail']);await context.close();
});
for(const mode of ['expired','redirect','refresh-wrong-user'])test('Viamail stops safely for '+mode,async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});mailboxMode=mode;
 const reader=new MailReader(context,{email:'user@example.com',accessToken:mailToken('user@example.com',mode==='refresh-wrong-user'?1:Math.floor(Date.now()/1000)+3600),refreshToken:'fixture-refresh'},async()=>{});await reader.install();
 await expect(reader.check()).rejects.toThrow();expect(received.some(r=>/delete-messages|interface|mail\/message/.test(r))).toBe(false);expect(received.filter(r=>r.includes('refresh-token')).length).toBeLessThanOrEqual(1);await context.close();
});

test('upgrades only one saved Viamail account from the app profile, without network requests',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 const page=await context.newPage();await page.goto('https://mail.viamtl.com/interface/root');
 const value={accessToken:mailToken(),refreshToken:'fixture-refresh'};
 await page.evaluate(value=>localStorage.setItem('userTokens',JSON.stringify({'user@example.com':value})),value);received=[];
 expect(await captureRememberedMailSession(context)).toEqual({email:'user@example.com',...value});expect(received).toEqual([]);
 await page.evaluate(value=>localStorage.setItem('userTokens',JSON.stringify({'user@example.com':value,'other@example.com':value})),value);
 expect(await captureRememberedMailSession(context)).toBeNull();expect(received).toEqual([]);await context.close();
});

test('manual Viamail handoff captures only the current identity and fails on token identity mismatch',async()=>{
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});const page=await context.newPage();await page.goto('https://mail.viamtl.com/interface/root');
 expect(await captureMailSession(page)).toMatchObject({email:'user@example.com',refreshToken:'fixture-refresh'});
 mailboxMode='wrong-user';await page.reload();await expect(captureMailSession(page)).rejects.toThrow(/identity/);await context.close();
});

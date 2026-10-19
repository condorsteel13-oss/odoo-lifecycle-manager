import {describe,it,expect} from 'vitest';
import {parseActivation,sameEmail,activationURL} from '../electron/activation';
import {matchingMessage,extractActivationLink} from '../electron/mailbox';
const target={copyName:'fixture-copy',email:'user@example.com',createdAt:new Date(Date.now()-60000).toISOString()};
const message=()=>({uid:5,folder:'inbox',from:{email:'online@odoo.com'},recipients:[{email:target.email}],subject:'Activate your database fixture-copy',internalDate:new Date().toISOString()});
describe('activation identity and email boundary',()=>{
 it('uses only the authenticated user_email and separately reads the stated recipient',()=>{expect(parseActivation({jsonrpc:'2.0',result:{status:'to_activate',user_email:'new-user@example.com',activation_email:'previous@example.com',email:'ignore@example.com'}})).toEqual({pending:true,activated:false,userEmail:'new-user@example.com',recipientEmail:'previous@example.com'});});
 it('does not interpret unknown states as completed activation',()=>{expect(parseActivation({jsonrpc:'2.0',result:{status:'new-unknown-state',user_email:target.email}}).activated).toBe(false);});
 it.each([null,'','not-an-email','user@example.com\nBcc:third@example.com'])('rejects invalid user email %s',email=>{expect(()=>parseActivation({jsonrpc:'2.0',result:{status:'to_activate',user_email:email}})).toThrow();});
 it('compares email casing without treating unknown recipients as matches',()=>{expect(sameEmail('USER@example.com',target.email)).toBe(true);expect(sameEmail(null,null)).toBe(false);});
 it('accepts only a recent, addressed Odoo activation message for the exact copy',()=>{expect(matchingMessage(message(),target)).toBe(true);});
 it.each(['sender','recipient','subject','stale','future','folder','uid'])('rejects unrelated %s messages before reading their bodies',kind=>{const m=message();if(kind==='sender')m.from.email='odoo@evil.example';if(kind==='recipient')m.recipients=[{email:'other@example.com'}];if(kind==='subject')m.subject='Activate unrelated-copy';if(kind==='stale')m.internalDate='2020-01-01T00:00:00Z';if(kind==='future')m.internalDate=new Date(Date.now()+120000).toISOString();if(kind==='folder')m.folder='shared';if(kind==='uid')m.uid=-1;expect(matchingMessage(m,target)).toBe(false);});
 it('parses email inertly and excludes tracking and external links',()=>{const html='<p>fixture-copy</p><script>bad()</script><img src="https://tracker.example"><a href="https://fixture-copy.odoo.com/saas_trial/confirm/1234567890123456">Activate</a><a href="https://evil.example">Activate</a>';expect(extractActivationLink(html,target)).toBe('https://fixture-copy.odoo.com/saas_trial/confirm/1234567890123456');});
 it.each(['https://evil.example/activate','https://fixture-copy.odoo.com/my/databases/delete','https://fixture-copy.odoo.com/saas_trial/confirm/1234567890123456?redirect=https://evil.example','http://fixture-copy.odoo.com/saas_trial/confirm/1234567890123456','https://other.odoo.com/saas_trial/confirm/1234567890123456'])('rejects unsafe activation destination %s',link=>{expect(()=>activationURL(link,target.copyName,target.email)).toThrow();});
 it('fails closed when multiple activation links exist',()=>{expect(()=>extractActivationLink('<p>fixture-copy</p><a href="https://fixture-copy.odoo.com/first">Activate</a><a href="https://fixture-copy.odoo.com/second">Activate</a>',target)).toThrow();});
});

it('accepts only the observed account activation route with exact copy and both current-user addresses',()=>{
 const good='https://www.odoo.com/odoo-enterprise/confirm-database/fixture-copy/'+('x'.repeat(140))+'?username=user%40example.com&email=user%40example.com&country_id=38';
 expect(activationURL(good,target.copyName,target.email).hostname).toBe('www.odoo.com');
 for(const bad of [good.replace('/fixture-copy/','/other-copy/'),good.replace('email=user%40','email=other%40'),good+'&redirect=https://evil.example',good+'&email=user%40example.com'])expect(()=>activationURL(bad,target.copyName,target.email)).toThrow();
});

it('keeps the explicit UTC trial expiry separate from the Manage countdown',()=>{expect(parseActivation({jsonrpc:'2.0',result:{status:'activated',user_email:target.email,expiry_oe:'2026-10-22 18:40:15'}}).expiresAt).toBe('2026-10-22T18:40:15Z');});
